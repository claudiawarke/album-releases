// scripts/update.js
const fs = require("fs");
const { execSync } = require("child_process");

const BATCH_SIZE = 1000;         // artists per batch
const BATCHES_PER_RUN = 5;       // batches per workflow run
const ARTISTS_FILE = "artists.json";
const ALBUMS_FILE = "albums.json";
const META_FILE = "meta.json";

// Load artists
const artists = JSON.parse(fs.readFileSync(ARTISTS_FILE, "utf-8"));

// Load meta
let meta = {
  last_run: null,
  last_full_cycle_completed: null,
  artists_checked_this_run: 0,
  last_batch_index: 0,
};
if (fs.existsSync(META_FILE)) {
  meta = { ...meta, ...JSON.parse(fs.readFileSync(META_FILE, "utf-8")) };
}

// Spotify auth
async function getSpotifyToken() {
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
        ).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await resp.json();
  return data.access_token;
}

// Fetch albums for one artist
async function fetchAlbumsForArtist(artistId, token) {
  let albums = [];
  let url = `https://api.spotify.com/v1/artists/${artistId}/albums?limit=50&include_groups=album,single`;

  while (url) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();

    if (data.items) {
      albums.push(
        ...data.items
          .filter(
            (a) =>
              a.album_type !== "compilation" && // exclude compilations
              a.artists.some((ar) => ar.id === artistId) // only main artist
          )
          .map((a) => ({
            id: a.id,
            album: a.name,
            artist: a.artists.map((ar) => ar.name).join(", "),
            release_date: a.release_date,
            cover: a.images[0]?.url || "",
            url: a.external_urls.spotify,
            type: a.album_type,
            total_tracks: a.total_tracks,
          }))
      );
    }

    url = data.next;
  }

  return albums;
}

// Batch helper
function getBatch(artists, batchIndex) {
  const start = batchIndex * BATCH_SIZE;
  const end = start + BATCH_SIZE;
  return artists.slice(start, end);
}

// Main runner
async function run() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    console.error("Missing Spotify secrets");
    process.exit(1);
  }

  const token = await getSpotifyToken();

  let allAlbums = [];
  if (fs.existsSync(ALBUMS_FILE)) {
    allAlbums = JSON.parse(fs.readFileSync(ALBUMS_FILE, "utf-8"));
  }

  let totalArtistsProcessed = 0;

  for (let i = 0; i < BATCHES_PER_RUN; i++) {
    const batch = getBatch(artists, meta.last_batch_index);

    if (!batch.length) {
      console.log("All batches completed. Starting new full cycle.");
      meta.last_batch_index = 0;
      meta.last_full_cycle_completed = new Date().toISOString().slice(0, 10);
      break;
    }

    console.log(`Processing batch ${meta.last_batch_index + 1}, ${batch.length} artists`);

    for (const artist of batch) {
      console.log("Fetching albums for:", artist.name);
      try {
        const albums = await fetchAlbumsForArtist(artist.id, token);
        console.log(`Found ${albums.length} albums for ${artist.name}`);
        allAlbums.push(...albums);
      } catch (err) {
        console.error("Error fetching artist:", artist.name, err);
      }
    }

    totalArtistsProcessed += batch.length;
    meta.last_batch_index += 1;
  }

  // Deduplicate albums
  const uniqueAlbums = Array.from(new Map(allAlbums.map((a) => [a.id, a])).values());
  fs.writeFileSync(ALBUMS_FILE, JSON.stringify(uniqueAlbums, null, 2));

  // Update meta
  meta.last_run = new Date().toISOString().slice(0, 10);
  meta.artists_checked_this_run = totalArtistsProcessed;
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

  console.log(`Run complete. Total albums: ${uniqueAlbums.length}`);
  console.log(`Artists processed this run: ${totalArtistsProcessed}`);

  // ---------- COMMIT & PUSH UPDATED FILES ----------
  try {
    execSync("git config user.name 'github-actions'", { stdio: "inherit" });
    execSync("git config user.email 'actions@github.com'", { stdio: "inherit" });
  
    const status = execSync("git status --porcelain").toString().trim();
    if (status) {
      execSync("git add albums.json meta.json", { stdio: "inherit" });
      execSync(
        `git commit -m "Update albums.json - ${new Date().toISOString().slice(0, 10)}"`,
        { stdio: "inherit" }
      );
      execSync("git push --force", { stdio: "inherit" });  // ← force push
      console.log("✅ albums.json and meta.json committed and pushed.");
    } else {
      console.log("No changes to commit or push.");
    }
  } catch (err) {
    console.error("Git commit/push failed:", err.message);
  }

}

run();
