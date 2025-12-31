const fs = require("fs");
const path = require("path");

const TODAY = new Date().toISOString().split("T")[0];
const ONE_WEEK_DAYS = 7;

const ARTISTS_FILE = "artists.json";
const ALBUMS_FILE = "albums.json";
const META_FILE = "meta.json";

// ---------- HELPERS ----------

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function classifyAlbum(album) {
  if (album.album_type === "single") return "single";
  if (album.album_type === "compilation") return "compilation";
  if (album.total_tracks <= 6) return "ep";
  return "album";
}

// ---------- SPOTIFY AUTH ----------

async function getSpotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!id || !secret) throw new Error("Missing Spotify secrets");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await res.json();
  return data.access_token;
}

// ---------- MAIN ----------

async function run() {
  const artists = readJSON(ARTISTS_FILE, []);
  const albums = readJSON(ALBUMS_FILE, []);
  const meta = readJSON(META_FILE, {});

  const token = await getSpotifyToken();

  // ---------- BATCH ARTISTS (WEEKLY ROTATION) ----------

  artists.forEach((a) => {
    if (!a.last_checked) a.last_checked = "1970-01-01";
  });

  artists.sort(
    (a, b) => new Date(a.last_checked) - new Date(b.last_checked)
  );

  const batchSize = Math.ceil(artists.length / ONE_WEEK_DAYS);
  const batch = artists.slice(0, batchSize);

  const updatedAlbums = [];

  for (const artist of batch) {
    const url = `https://api.spotify.com/v1/artists/${artist.id}/albums?include_groups=album,single,appears_on&limit=50`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await res.json();
    if (!data.items) continue;

    for (const album of data.items) {
      const existing = albums.find((a) => a.id === album.id);

      const albumRes = await fetch(
        `https://api.spotify.com/v1/albums/${album.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const albumData = await albumRes.json();

      const trackIds = albumData.tracks.items.map((t) => t.id);

      if (existing) {
        const changed =
          existing.total_tracks !== trackIds.length ||
          existing.track_ids.join() !== trackIds.join();

        if (changed && existing.release_date < TODAY) {
          existing.updated_after_release = true;
          existing.last_updated = TODAY;
          existing.total_tracks = trackIds.length;
          existing.track_ids = trackIds;
          updatedAlbums.push(existing);
        }

        existing.last_seen = TODAY;
      } else {
        albums.push({
          id: album.id,
          name: album.name,
          artist: album.artists.map((a) => a.name).join(", "),
          release_date: album.release_date,
          type: classifyAlbum(album),
          total_tracks: trackIds.length,
          track_ids: trackIds,
          spotify_url: album.external_urls.spotify,
          cover: album.images[0]?.url || "",
          last_seen: TODAY,
          updated_after_release: false,
        });
      }
    }

    artist.last_checked = TODAY;
  }

  // ---------- META TRACKING ----------

  meta.last_run = TODAY;
  meta.artists_checked_this_run = batch.length;

  const allCheckedRecently = artists.every(
    (a) => new Date(a.last_checked) >= new Date(meta.cycle_start || "1970-01-01")
  );

  if (!meta.cycle_start) meta.cycle_start = TODAY;

  if (allCheckedRecently) {
    meta.last_full_cycle_completed = TODAY;
    meta.cycle_start = TODAY;
  }

  writeJSON(ARTISTS_FILE, artists);
  writeJSON(ALBUMS_FILE, albums);
  writeJSON(META_FILE, meta);

  // ---------- GITHUB ISSUE FOR UPDATES ----------

  if (updatedAlbums.length > 0) {
    await createGithubIssue(updatedAlbums);
  }
}

// ---------- GITHUB ISSUE ----------

async function createGithubIssue(updatedAlbums) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  const body = updatedAlbums
    .map(
      (a) => `
• **${a.artist} – ${a.name}**
  Tracks now: ${a.total_tracks}
  Updated: ${a.last_updated}
  Spotify: ${a.spotify_url}
`
    )
    .join("\n");

  await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `Albums updated after release – ${TODAY}`,
      body,
    }),
  });
}

run();
