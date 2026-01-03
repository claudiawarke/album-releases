const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

// 1. Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = 1000;         // artists per batch
const BATCHES_PER_RUN = 5;       // batches per workflow run
const ARTISTS_FILE = "artists.json";
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
              a.album_type !== "compilation" && 
              a.artists.some((ar) => ar.id === artistId)
          )
          .map((a) => ({
            id: a.id,
            album: a.name,
            artist: a.artists.map((ar) => ar.name).join(", "),
            artist_id: artistId, // Added this to match your table
            release_date: a.release_date,
            cover: a.images[0]?.url || "",
            url: a.external_urls.spotify,
            type: a.album_type,
            total_tracks: a.total_tracks
            // status and trashed_at default to 'active' and null in DB
          }))
      );
    }
    url = data.next;
  }
  return albums;
}

function getBatch(artists, batchIndex) {
  const start = batchIndex * BATCH_SIZE;
  const end = start + BATCH_SIZE;
  return artists.slice(start, end);
}

async function run() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing secrets");
    process.exit(1);
  }

  const token = await getSpotifyToken();
  let totalArtistsProcessed = 0;

  for (let i = 0; i < BATCHES_PER_RUN; i++) {
    const batch = getBatch(artists, meta.last_batch_index);

    if (!batch.length) {
      console.log("All batches completed. Starting new full cycle.");
      meta.last_batch_index = 0;
      meta.last_full_cycle_completed = new Date().toISOString().slice(0, 10);
      break;
    }

    console.log(`Processing batch ${meta.last_batch_index + 1}`);
    let albumsToUpload = [];

    for (const artist of batch) {
      try {
        const albums = await fetchAlbumsForArtist(artist.id, token);
        albumsToUpload.push(...albums);
      } catch (err) {
        console.error("Error fetching artist:", artist.name);
      }
    }

    // Upload to Supabase
    if (albumsToUpload.length > 0) {
      console.log(`Uploading ${albumsToUpload.length} albums to Supabase...`);
      const { error } = await supabase
        .from('albums')
        .upsert(albumsToUpload, { onConflict: 'id', ignoreDuplicates: true });

      if (error) console.error("Supabase Error:", error.message);
    }

    totalArtistsProcessed += batch.length;
    meta.last_batch_index += 1;
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  }

  meta.last_run = new Date().toISOString().slice(0, 10);
  meta.artists_checked_this_run = totalArtistsProcessed;
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

  // Push meta changes
  const { execSync } = require("child_process");
  try {
    execSync("git config user.name 'github-actions'");
    execSync("git config user.email 'actions@github.com'");
    execSync("git add meta.json");
    execSync(`git commit -m "Update progress [skip ci]"`);
    execSync("git push");
  } catch (e) {
    console.log("No meta changes to push");
  }
}

run();
