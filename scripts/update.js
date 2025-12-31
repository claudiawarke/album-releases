const fs = require("fs");

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

env:
  CLIENT_ID: ${{ secrets.CLIENT_ID }}
  CLIENT_SECRET: ${{ secrets.CLIENT_SECRET }}

async function getToken() {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await res.json();
  return data.access_token;
}

async function run() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing Spotify secrets");
  }

  const token = await getToken();

  const artists = JSON.parse(fs.readFileSync("artists.json", "utf8"));
  const existing = JSON.parse(fs.readFileSync("albums.json", "utf8"));

  const seen = new Set(existing.map((a) => a.id));
  const added = [];

  for (const artist of artists) {
    const res = await fetch(
      `https://api.spotify.com/v1/artists/${artist.id}/albums?include_groups=album&limit=5`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await res.json();
    if (!data.items) continue;

    for (const album of data.items) {
      if (!seen.has(album.id)) {
        added.push({
          id: album.id,
          album: album.name,
          artist: artist.name,
          release_date: album.release_date,
          cover: album.images?.[0]?.url || "",
          url: album.external_urls.spotify,
        });
      }
    }
  }

  const merged = [...added, ...existing].sort(
    (a, b) => new Date(b.release_date) - new Date(a.release_date)
  );

  fs.writeFileSync("albums.json", JSON.stringify(merged, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
