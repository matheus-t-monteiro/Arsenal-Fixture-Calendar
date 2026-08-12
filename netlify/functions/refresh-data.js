// Scheduled Netlify Function — runs automatically on the cron set in
// netlify.toml (currently every 6 hours). It is the ONLY piece of this
// project that talks to API-Football, and it never runs in the visitor's
// browser, so the API key (read from the API_FOOTBALL_KEY environment
// variable, set in the Netlify UI) is never exposed publicly.
//
// What it does each run:
//   1. Resolves Arsenal Men's and Arsenal Women's API-Football team IDs
//      (cached in Netlify Blobs after the first successful lookup, so we
//      don't spend a request re-resolving them every run).
//   2. Resolves competition/league IDs by name (also cached).
//   3. Pulls this season's fixtures for both teams (scores).
//   4. For recently-finished fixtures, pulls goal-scorer events.
//   5. Pulls squad statistics (appearances/minutes/goals/assists) per
//      competition for both squads.
//   6. Writes one compact JSON blob that arsenal-data.js (the on-demand
//      function the calendar actually fetches from) simply reads back.
//
// If anything fails partway (a competition with no data yet, a rate limit,
// etc.) we log a warning and keep going — a partial update is fine, the
// calendar's static baked-in data is always the fallback for whatever
// this run didn't manage to refresh.

const { getStore } = require("@netlify/blobs");

const API_BASE = "https://v3.football.api-sports.io";
const STORE_NAME = "arsenal-data";

function currentSeasonYear() {
  const now = new Date();
  const y = now.getUTCFullYear();
  // European club seasons start around July/August — before that, we're
  // still in the previous season year as far as API-Football is concerned.
  return now.getUTCMonth() >= 6 ? y : y - 1;
}

function stripDiacritics(str) {
  return str
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[øØ]/g, (c) => (c === "ø" ? "o" : "O"))
    .replace(/[æÆ]/g, (c) => (c === "æ" ? "ae" : "AE"));
}

async function apiGet(path, key) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "x-apisports-key": key }
  });
  if (!res.ok) throw new Error(`API-Football ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API-Football ${path} -> ${JSON.stringify(json.errors)}`);
  }
  return json.response || [];
}

async function resolveTeamId(key, cache, cacheKey, matcher) {
  if (cache[cacheKey]) return cache[cacheKey];
  const results = await apiGet(`/teams?search=arsenal`, key);
  const match = results.find(matcher);
  if (!match) throw new Error(`Could not resolve team id for ${cacheKey}`);
  cache[cacheKey] = match.team.id;
  return match.team.id;
}

async function resolveLeagueId(key, cache, cacheKey, searchTerm, country) {
  if (cache[cacheKey]) return cache[cacheKey];
  const q = country ? `&country=${encodeURIComponent(country)}` : "";
  const results = await apiGet(`/leagues?search=${encodeURIComponent(searchTerm)}${q}`, key);
  if (!results.length) throw new Error(`Could not resolve league id for ${cacheKey} ("${searchTerm}")`);
  // Prefer an exact-ish name match, else take the first result.
  const best =
    results.find((r) => r.league.name.toLowerCase() === searchTerm.toLowerCase()) ||
    results[0];
  cache[cacheKey] = best.league.id;
  return best.league.id;
}

// Competitions we try to track. Each maps to the `compKey` used in the
// calendar's own data model (see menSquadStatCats / womenSquadStatCats in
// index.html) so squad stats land in the right bucket automatically.
// Niche/low-coverage competitions (Community Shield, Women's League Cup,
// etc.) are still attempted but failures here are expected and harmless —
// they just won't get live squad stats until the API has data for them.
const MEN_LEAGUES = [
  { compKey: "pl", term: "Premier League", country: "England" },
  { compKey: "cl", term: "UEFA Champions League" },
  { compKey: "efl", term: "EFL Cup" },
  { compKey: "fa", term: "FA Cup" },
  { compKey: "shield", term: "Community Shield" }
];
const WOMEN_LEAGUES = [
  { compKey: "wsl", term: "Women Super League" },
  { compKey: "wcl", term: "UEFA Women's Champions League" },
  { compKey: "facup", term: "Women's FA Cup" },
  { compKey: "leaguecup", term: "Women's League Cup" }
  // "fifacc" (FIFA Women's Champions Cup) intentionally omitted — brand
  // new competition, not reliably searchable yet. Add a term here once
  // API-Football lists it.
];

async function fetchTeamData(key, teamId, leagueDefs, idCache, cacheKeyToApiId) {
  const season = currentSeasonYear();

  // Resolve whichever league IDs we don't already have cached.
  for (const def of leagueDefs) {
    try {
      const id = await resolveLeagueId(key, idCache.leagues, def.compKey, def.term, def.country);
      cacheKeyToApiId[def.compKey] = id;
    } catch (err) {
      console.warn(`[refresh-data] ${err.message}`);
    }
  }
  const apiIdToCompKey = {};
  Object.entries(cacheKeyToApiId).forEach(([compKey, apiId]) => (apiIdToCompKey[apiId] = compKey));

  // --- Fixtures (scores) ---
  const fixtures = await apiGet(`/fixtures?team=${teamId}&season=${season}`, key);
  const fixtureResults = fixtures
    .filter((f) => ["FT", "AET", "PEN"].includes(f.fixture.status.short))
    .map((f) => {
      const isHome = f.teams.home.id === teamId;
      return {
        date: f.fixture.date.slice(0, 10),
        opp: (isHome ? f.teams.away.name : f.teams.home.name),
        fixtureId: f.fixture.id,
        arsenalGoals: isHome ? f.goals.home : f.goals.away,
        opponentGoals: isHome ? f.goals.away : f.goals.home,
        isHome
      };
    });

  // --- Scorers, only for fixtures played in the last 10 days (keeps the
  // request count small and bounded on every run instead of re-fetching
  // events for matches from months ago every single time). ---
  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const scorersByFixture = {};
  for (const f of fixtureResults) {
    if (new Date(f.date).getTime() < tenDaysAgo) continue;
    try {
      const events = await apiGet(`/fixtures/events?fixture=${f.fixtureId}`, key);
      const goals = events.filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty");
      const arsenal = [];
      const opponent = [];
      goals.forEach((g) => {
        const scoredForArsenal =
          (g.team.id === teamId) !== (g.detail === "Own Goal"); // own goal flips which side it counts for
        const entry = { name: g.player.name, min: g.time.elapsed + (g.time.extra ? g.time.extra : 0) };
        (scoredForArsenal ? arsenal : opponent).push(entry);
      });
      scorersByFixture[`${f.date}|${f.opp}`] = { arsenal, opponent };
    } catch (err) {
      console.warn(`[refresh-data] events fetch failed for fixture ${f.fixtureId}: ${err.message}`);
    }
  }

  const fixturesOut = {};
  fixtureResults.forEach((f) => {
    const mkey = `${f.date}|${f.opp}`;
    fixturesOut[mkey] = {
      score: { arsenal: f.arsenalGoals, opponent: f.opponentGoals },
      scorers: scorersByFixture[mkey] || null
    };
  });

  // --- Squad stats ---
  const squadStats = {};
  try {
    let page = 1;
    let totalPages = 1;
    do {
      const players = await apiGet(`/players?team=${teamId}&season=${season}&page=${page}`, key);
      players.forEach((entry) => {
        const lastName = stripDiacritics(entry.player.lastname || entry.player.name || "").toLowerCase().trim();
        if (!lastName) return;
        const stats = {};
        (entry.statistics || []).forEach((s) => {
          const compKey = apiIdToCompKey[s.league && s.league.id];
          if (!compKey) return; // competition we're not tracking / couldn't resolve
          stats[compKey] = {
            app: s.games.appearences || 0,
            min: s.games.minutes || 0,
            g: (s.goals && s.goals.total) || 0,
            a: (s.goals && s.goals.assists) || 0
          };
        });
        if (Object.keys(stats).length) squadStats[lastName] = stats;
      });
      // Netlify's fetch response doesn't carry the `paging` object through
      // apiGet's simplified return, so just check page count via a second
      // lightweight guard: stop once a page comes back empty.
      totalPages = players.length ? totalPages + 1 : 0;
      page++;
    } while (page <= totalPages && page <= 3); // safety cap
  } catch (err) {
    console.warn(`[refresh-data] squad stats fetch failed: ${err.message}`);
  }

  return { fixtures: fixturesOut, squadStats };
}

exports.handler = async () => {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    console.error("[refresh-data] API_FOOTBALL_KEY environment variable is not set — skipping run.");
    return { statusCode: 200, body: "No API key configured, nothing to do." };
  }

  const store = getStore(STORE_NAME);
  const idCache = (await store.get("id-cache", { type: "json" })) || { teams: {}, leagues: {} };

  const result = { updatedAt: new Date().toISOString(), men: null, women: null, errors: [] };

  try {
    const menTeamId = await resolveTeamId(key, idCache.teams, "men", (t) => t.team.name === "Arsenal" && t.team.country === "England");
    idCache.leagues.men = idCache.leagues.men || {};
    const menLeagueIds = {};
    result.men = await fetchTeamData(key, menTeamId, MEN_LEAGUES, { leagues: idCache.leagues.men }, menLeagueIds);
  } catch (err) {
    console.error(`[refresh-data] men's data failed: ${err.message}`);
    result.errors.push(`men: ${err.message}`);
  }

  try {
    const womenTeamId = await resolveTeamId(key, idCache.teams, "women", (t) => t.team.name.toLowerCase().includes("arsenal") && t.team.name.toLowerCase().includes("women"));
    idCache.leagues.women = idCache.leagues.women || {};
    const womenLeagueIds = {};
    result.women = await fetchTeamData(key, womenTeamId, WOMEN_LEAGUES, { leagues: idCache.leagues.women }, womenLeagueIds);
  } catch (err) {
    console.error(`[refresh-data] women's data failed: ${err.message}`);
    result.errors.push(`women: ${err.message}`);
  }

  await store.setJSON("id-cache", idCache);
  await store.setJSON("latest", result);

  console.log(`[refresh-data] done. men fixtures: ${result.men ? Object.keys(result.men.fixtures).length : 0}, women fixtures: ${result.women ? Object.keys(result.women.fixtures).length : 0}, errors: ${result.errors.length}`);

  return { statusCode: 200, body: "ok" };
};
