import fs from "fs";

const tokenRes = await fetch(
  "https://accounts.spotify.com/api/token",
  {
    method: "POST",
    headers: {
      "Authorization":
        "Basic " +
        Buffer.from(
          process.env.SPOTIFY_CLIENT_ID +
            ":" +
            process.env.SPOTIFY_CLIENT_SECRET
        ).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  }
);

const { access_token } = await tokenRes.json();

const artists = JSON.parse(fs.readFileSync("artists.json"));
const existing = JSON.parse(fs.readFileSync("albums.json"));

const existingIds = new Set(existing.map(a => a.id));
let newAlbums = [];

for (const artist of artists) {
  const res = await fetch(
    `https://api.spotify.com/v1/artists/${artist.id}/albums?include_groups=album&limit=10`,
    {
      headers: {
        Authorization: `Bearer ${access_token}`
      }
    }
  );

  const data = await res.json();

  for (const album of data.items) {
    if (!existingIds.has(album.id)) {
      newAlbums.push({
        id: album.id,
        album: album.name,
        artist: artist.name,
        release_date: album.release_date,
        cover: album.images[0]?.url,
        url: album.external_urls.spotify
      });
    }
  }
}

const merged = [...newAlbums, ...existing].sort(
  (a, b) => new Date(b.release_date) - new Date(a.release_date)
);

fs.writeFileSync("albums.json", JSON.stringify(merged, null, 2));
