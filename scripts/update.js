const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = 1000;
const BATCHES_PER_RUN = 5;
const ARTISTS_FILE = "artists.json";
const META_FILE = "meta.json";

const artists = JSON.parse(fs.readFileSync(ARTISTS_FILE, "utf-8"));

let meta = {
  last_run: null,
  last_full_cycle_completed: null,
  artists_checked_this_run: 0,
  last_batch_index: 0,
};
if (fs.existsSync(META_FILE)) {
  meta = { ...meta, ...JSON.parse(fs.readFileSync(META_FILE, "utf-8")) };
}

// HELPER: Fixes Spotify dates for Supabase (e.g. "2004" -> "2004-01-01")
function normalizeDate(dateStr) {
  if (!dateStr) return "1970-01-01";
  const parts = dateStr.split("-");
  if (parts.length === 1) return `${parts[0]}-01-01`;
  if (parts.length === 2) return `${parts[0]}-${parts[1]}-01`;
  return dateStr;
}

async function getSpotifyToken() {
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await resp.json();
  return data.access_token;
}

async function fetchAlbumsForArtist(artistId, token) {
  let albums = [];
  let url = `https://api.spotify.com/v1/artists/${artistId}/albums?limit=50&include_groups=album,single`;

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();

    if (data.items) {
      albums.push(
        ...data.items
          .filter(a => a.album_type !== "compilation" && a.artists.some(ar => ar.id === artistId))
          .map(a => ({
            id: a.id,
            album: a.name,
            artist: a.artists.map(ar => ar.name).join(", "),
            artist_id: artistId,
            release_date: normalizeDate(a.release_date), // <-- FIX APPLIED HERE
            cover: a.images[0]?.url || "",
            url: a.external_urls.spotify,
            type: a.album_type,
            total_tracks: a.total_tracks
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
      console.log("All batches completed.");
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

    if (albumsToUpload.length > 0) {
      // --- NEW: DEDUPLICATE BY TITLE/ARTIST (Handles Clean vs Explicit) ---
      console.log(`Deduplicating ${albumsToUpload.length} albums by title...`);
      const uniqueAlbumsByTitle = new Map();
      
      for (const a of albumsToUpload) {
        // Create a unique key based on Artist + Album Name (e.g., "SZA-SOS")
        // We lowercase it to ensure "SOS" and "sos" are treated as the same
        const key = `${a.artist}-${a.album}`.toLowerCase();
        
        // If we haven't seen this Title + Artist combo yet, keep it.
        // Spotify returns the 'primary' (usually Explicit) version first.
        if (!uniqueAlbumsByTitle.has(key)) {
          uniqueAlbumsByTitle.set(key, a);
        }
      }
      
      const deduplicatedList = Array.from(uniqueAlbumsByTitle.values());
      console.log(`Reduced to ${deduplicatedList.length} unique titles.`);

      // --- PROCEED TO CHECK SUPABASE ---
      console.log(`Checking for existing albums among candidates...`);
      const allIds = [...new Set(deduplicatedList.map(a => a.id))];
      
      const existingIds = new Set();
      for (let j = 0; j < allIds.length; j += 500) {
        const chunk = allIds.slice(j, j + 500);
        const { data } = await supabase
          .from('albums')
          .select('id')
          .in('id', chunk);
        
        if (data) {
          data.forEach(row => existingIds.add(row.id));
        }
      }

      const trulyNewAlbums = deduplicatedList.filter(a => !existingIds.has(a.id));

      if (trulyNewAlbums.length > 0) {
        console.log(`Inserting ${trulyNewAlbums.length} NEW albums...`);
        const { error } = await supabase
          .from('albums')
          .insert(trulyNewAlbums);

        if (error) {
          console.error("Supabase Error:", error.message);
          process.exit(1); 
        }
      } else {
        console.log("No new albums found. Trash and Listen status preserved.");
      }
    }

    totalArtistsProcessed += batch.length;
    meta.last_batch_index += 1;
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  }

  meta.last_run = new Date().toISOString().slice(0, 10);
  meta.artists_checked_this_run = totalArtistsProcessed;
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

  try {
    const { execSync } = require("child_process");
    execSync("git config user.name 'github-actions'");
    execSync("git config user.email 'actions@github.com'");
    execSync("git add meta.json");
    execSync(`git commit -m "Update progress [skip ci]"`);
    execSync("git push");
  } catch (e) {}
}

run();
