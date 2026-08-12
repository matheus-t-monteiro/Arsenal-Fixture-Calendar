// On-demand Netlify Function the calendar's browser JS actually calls
// (from either the Netlify site or the GitHub Pages copy — both are
// allowed via the CORS header below). This function does NOT call
// API-Football itself; it just reads back whatever refresh-data.js most
// recently saved, so it responds instantly and never touches your
// API-Football request quota no matter how many visitors load the page.

const { getStore } = require("@netlify/blobs");

exports.handler = async () => {
  const store = getStore("arsenal-data");
  const data = (await store.get("latest", { type: "json" })) || {
    updatedAt: null,
    men: { fixtures: {}, squadStats: {} },
    women: { fixtures: {}, squadStats: {} },
    errors: []
  };

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300" // 5 min edge cache; data itself only changes every few hours
    },
    body: JSON.stringify(data)
  };
};
