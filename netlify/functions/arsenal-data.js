// Single Netlify Function, zero npm dependencies (uses only the built-in
// `fetch` Node 18+ already provides). The calendar's browser JS calls this
// on load. It talks to API-Football, using the API_FOOTBALL_KEY
// environment variable you set in the Netlify UI (never seen by anyone
// else — this code only runs on Netlify's servers, never in the browser).
//
// To stay well inside API-Football's 100-requests/day free-tier cap no
// matter how many people load the page, results are kept in memory for
// CACHE_TTL_MS and reused across requests that land on the same warm
// function instance. Team/league IDs are resolved once and cached
// indefinitely (they never change). Worst case — a cold start with an
// expired cache — this makes on the order of 15-25 API calls; typical
// case, once warm, is zero.

const API_BASE = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Module-scope = persists across invocations on the same warm container.
let dataCache = { data: null, fetchedAt: 0 };
let idCache = { teams: {}, menLeagues: {}, womenLeagues: {} };

function currentSeasonYear() {
  const now = new Date();
  const y = now.getUTCFullYear();
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
  const res = await fetch(`${API_BASE}${path}`, { headers: { "x-apisports-key": key } });
  if (!res.ok) throw new Error(`API-Football ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API-Football ${path} -> ${JSON.stringify(json.errors)}`);
  }
  return json.response || [];
}

async function resolveTeamId(key, cacheKey, matcher) {
  if (idCache.teams[cacheKey]) return idCache.teams[cacheKey];
  const results = await apiGet(`/teams?search=arsenal`, key);
  const match = results.find(matcher);
  if (!match) throw new Error(`Could not resolve team id for ${cacheKey}`);
  idCache.teams[cacheKey] = match.team.id;
  return match.team.id;
}

async function resolveLeagueId(key, cache, cacheKey, searchTerm, country) {
  if (cache[cacheKey]) return cache[cacheKey];
  const q = country ? `&country=${encodeURIComponent(country)}` : "";
  const results = await apiGet(`/leagues?search=${encodeURIComponent(searchTerm)}${q}`, key);
  if (!results.length) throw new Error(`Could not resolve league id for ${cacheKey} ("${searchTerm}")`);
  const best =
    results.find((r) => r.league.name.toLowerCase() === searchTerm.toLowerCase()) || results[0];
  cache[cacheKey] = best.league.id;
  return best.league.id;
}

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
];

async function fetchTeamData(key, teamId, leagueDefs, leagueIdCache) {
  const season = currentSeasonYear();
  const compKeyToApiId = {};
  for (const def of leagueDefs) {
    try {
      compKeyToApiId[def.compKey] = await resolveLeagueId(key, leagueIdCache, def.compKey, def.term, def.country);
    } catch (err) {
      console.warn(`[arsenal-data] ${err.message}`);
    }
  }
  const apiIdToCompKey = {};
  Object.entries(compKeyToApiId).forEach(([compKey, apiId]) => (apiIdToCompKey[apiId] = compKey));

  const fixtures = await apiGet(`/fixtures?team=${teamId}&season=${season}`, key);
  const finished = fixtures
    .filter((f) => ["FT", "AET", "PEN"].includes(f.fixture.status.short))
    .map((f) => {
      const isHome = f.teams.home.id === teamId;
      return {
        date: f.fixture.date.slice(0, 10),
        opp: isHome ? f.teams.away.name : f.teams.home.name,
        fixtureId: f.fixture.id,
        arsenalGoals: isHome ? f.goals.home : f.goals.away,
        opponentGoals: isHome ? f.goals.away : f.goals.home
      };
    });

  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const scorersByKey = {};
  for (const f of finished) {
    if (new Date(f.date).getTime() < tenDaysAgo) continue;
    try {
      const events = await apiGet(`/fixtures/events?fixture=${f.fixtureId}`, key);
      const goals = events.filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty");
      const arsenal = [];
      const opponent = [];
      goals.forEach((g) => {
        const scoredForArsenal = (g.team.id === teamId) !== (g.detail === "Own Goal");
        const entry = { name: g.player.name, min: g.time.elapsed + (g.time.extra || 0) };
        (scoredForArsenal ? arsenal : opponent).push(entry);
      });
      scorersByKey[`${f.date}|${f.opp}`] = { arsenal, opponent };
    } catch (err) {
      console.warn(`[arsenal-data] events fetch failed for fixture ${f.fixtureId}: ${err.message}`);
    }
  }

  const fixturesOut = {};
  finished.forEach((f) => {
    const mkey = `${f.date}|${f.opp}`;
    fixturesOut[mkey] = {
      score: { arsenal: f.arsenalGoals, opponent: f.opponentGoals },
      scorers: scorersByKey[mkey] || null
    };
  });

  const squadStats = {};
  try {
    let page = 1;
    let more = true;
    while (more && page <= 3) {
      const players = await apiGet(`/players?team=${teamId}&season=${season}&page=${page}`, key);
      players.forEach((entry) => {
        const lastName = stripDiacritics(entry.player.lastname || entry.player.name || "").toLowerCase().trim();
        if (!lastName) return;
        const stats = {};
        (entry.statistics || []).forEach((s) => {
          const compKey = apiIdToCompKey[s.league && s.league.id];
          if (!compKey) return;
          stats[compKey] = {
            app: s.games.appearences || 0,
            min: s.games.minutes || 0,
            g: (s.goals && s.goals.total) || 0,
            a: (s.goals && s.goals.assists) || 0
          };
        });
        if (Object.keys(stats).length) squadStats[lastName] = stats;
      });
      more = players.length > 0;
      page++;
    }
  } catch (err) {
    console.warn(`[arsenal-data] squad stats fetch failed: ${err.message}`);
  }

  return { fixtures: fixturesOut, squadStats };
}

async function buildFreshData(key) {
  const result = { updatedAt: new Date().toISOString(), men: null, women: null, errors: [] };

  try {
    const menTeamId = await resolveTeamId(key, "men", (t) => t.team.name === "Arsenal" && t.team.country === "England");
    result.men = await fetchTeamData(key, menTeamId, MEN_LEAGUES, idCache.menLeagues);
  } catch (err) {
    console.error(`[arsenal-data] men's data failed: ${err.message}`);
    result.errors.push(`men: ${err.message}`);
  }

  try {
    const womenTeamId = await resolveTeamId(
      key,
      "women",
      (t) => t.team.name.toLowerCase().includes("arsenal") && t.team.name.toLowerCase().includes("women")
    );
    result.women = await fetchTeamData(key, womenTeamId, WOMEN_LEAGUES, idCache.womenLeagues);
  } catch (err) {
    console.error(`[arsenal-data] women's data failed: ${err.message}`);
    result.errors.push(`women: ${err.message}`);
  }

  return result;
}

exports.handler = async () => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300"
  };

  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        updatedAt: null,
        men: { fixtures: {}, squadStats: {} },
        women: { fixtures: {}, squadStats: {} },
        errors: ["API_FOOTBALL_KEY environment variable is not set"]
      })
    };
  }

  const fresh = Date.now() - dataCache.fetchedAt < CACHE_TTL_MS;
  if (fresh && dataCache.data) {
    return { statusCode: 200, headers, body: JSON.stringify(dataCache.data) };
  }

  try {
    const data = await buildFreshData(key);
    dataCache = { data, fetchedAt: Date.now() };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    // Total failure (e.g. network error) — serve stale cache if we have
    // any, rather than nothing.
    console.error(`[arsenal-data] build failed: ${err.message}`);
    if (dataCache.data) {
      return { statusCode: 200, headers, body: JSON.stringify(dataCache.data) };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        updatedAt: null,
        men: { fixtures: {}, squadStats: {} },
        women: { fixtures: {}, squadStats: {} },
        errors: [err.message]
      })
    };
  }
};
