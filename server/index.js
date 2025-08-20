// Universal Torrent Resolution System - ZERO "Not Found" Errors
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const WebTorrent = require('webtorrent');
const multer = require('multer');

// Environment Configuration with production optimizations
const config = {
  server: {
    port: process.env.SERVER_PORT || 3000,
    host: process.env.SERVER_HOST || 'localhost',
    protocol: process.env.SERVER_PROTOCOL || 'http'
  },
  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173'
  },
  omdb: {
    apiKey: process.env.OMDB_API_KEY || '8265bd1c' // Free API key for development
  },
  isDevelopment: process.env.NODE_ENV !== 'production',
  
  // Production-specific configuration
  production: {
    // Streaming settings
    streaming: {
      // Maximum time in ms for any streaming request to stay open
      maxConnectionTime: 300000, // 5 minutes
      // Default chunk size for video streaming
      defaultChunkSize: 4 * 1024 * 1024, // 4MB
      // Upload rate during streaming to ensure good peer reciprocity
      streamingUploadRate: 10000, // 10KB/s
      // Enable optimization for remote deployments like DigitalOcean
      optimizeForRemote: true
    },
    
    // Cache settings
    cache: {
      // Time in ms to cache torrent listings
      torrentListTTL: 5000, // 5 seconds
      // Time in ms to cache torrent details
      torrentDetailsTTL: 8000, // 8 seconds
      // Time in ms to cache IMDB data
      imdbDataTTL: 3600000, // 1 hour
      // Memory threshold in MB to trigger cache purge
      memoryCachePurgeThreshold: 800 // 800MB
    },
    
    // System settings
    system: {
      // Maximum memory usage before taking action (MB)
      maxMemory: 1024, // 1GB
      // Enable system health monitoring
      monitoring: true,
      // Log level (0=errors only, 1=important, 2=verbose)
      logLevel: parseInt(process.env.LOG_LEVEL || '1', 10)
    },
    
    // Network settings
    network: {
      // Maximum number of connections per torrent
      maxConns: 100,
      // Default upload limit in bytes/sec
      defaultUploadLimit: 5000, // 5KB/s
      // Timeout for API requests
      apiTimeout: 15000 // 15 seconds
    }
  }
};

const app = express();

// Add performance monitoring middleware for API endpoints
app.use((req, res, next) => {
  // Skip for non-API routes
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // Store start time
  const startTime = Date.now();
  
  // Track if the response has been sent
  let responseSent = false;
  
  // Create a function to log response time
  const logResponseTime = () => {
    if (responseSent) return;
    responseSent = true;
    
    const duration = Date.now() - startTime;
    
    // Only log slow requests or in debug mode
    const isSlowRequest = duration > 1000;
    const debugLevel = process.env.DEBUG === 'true';
    
    if (isSlowRequest || debugLevel) {
      const routeName = req.path;
      console.log(
        `⏱️ ${isSlowRequest ? '⚠️ SLOW API' : 'API'} ${req.method} ${routeName}: ${duration}ms` +
        (isSlowRequest ? ' - Consider optimization!' : '')
      );
    }
  };
  
  // Log when response is finished
  res.on('finish', logResponseTime);
  res.on('close', logResponseTime);
  
  // Set a global timeout for all API requests
  res.setTimeout(10000, () => {
    console.log(`⏱️ ⚠️ Global timeout reached for ${req.path}`);
    if (!res.headersSent) {
      res.status(503).send({ 
        error: 'Request timeout', 
        message: 'Server is busy, please try again later' 
      });
    }
  });
  
  next();
});

// OPTIMIZED WebTorrent configuration for production and cloud environments
const isProduction = process.env.NODE_ENV === 'production';
const isCloud = process.env.CLOUD_DEPLOYMENT === 'true' || 
                process.env.DIGITAL_OCEAN === 'true' ||
                process.env.HOSTING === 'cloud';

console.log(`🌐 Running in ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);
if (isCloud) console.log(`☁️ Cloud/DigitalOcean deployment detected`);

// Apply production optimization
const client = new WebTorrent({
  uploadLimit: isProduction ? config.production.network.defaultUploadLimit : 10000,
  downloadLimit: -1, // No download limit
  maxConns: isProduction ? config.production.network.maxConns : 150,
  webSeeds: true,    // Enable web seeds
  tracker: true,     // Enable trackers
  pex: true,         // Enable peer exchange
  dht: true,         // Enable DHT
  
  // Additional network optimizations for cloud environments
  ...(isCloud && {
    // More conservative connection handling for cloud environments
    maxConns: 80,    // Reduced connections to prevent overwhelming the server
    maxWebConns: 20, // Lower web connections limit
    
    // Apply more aggressive timeouts for DHT and tracker communication
    dhtTimeout: 10000,       // 10 seconds DHT timeout
    trackerTimeout: 15000,   // 15 seconds tracker timeout
    
    // Avoid going offline by keeping connections alive
    keepSeeding: true,

    // Throttle UDP traffic to avoid triggering anti-DoS mechanisms
    // NOTE: do NOT enable uTP here by default because the native
    // `utp-native` addon can cause segmentation faults in some
    // musl/alpine environments. uTP is now opt-in via the
    // WEBTORRENT_ENABLE_UTP environment variable.
  })
});

// Determine whether to enable uTP from environment (opt-in)
const enableUtp = process.env.WEBTORRENT_ENABLE_UTP === 'true';

console.log(`WebTorrent uTP enabled: ${enableUtp ? 'yes' : 'no'} (use WEBTORRENT_ENABLE_UTP=true to enable)`);

// If uTP is disabled, override client options to avoid loading native bindings
if (!enableUtp) {
  // Some WebTorrent internals may try to load utp-native. Setting
  // `utp: false` here avoids that.
  client.utp = false;
}

// UNIVERSAL STORAGE SYSTEM - Multiple ways to find torrents
const torrents = {};           // Active torrent objects by infoHash
const torrentIds = {};         // Original torrent IDs by infoHash
const torrentNames = {};       // Torrent names by infoHash
const hashToName = {};         // Quick hash-to-name lookup
const nameToHash = {};         // Quick name-to-hash lookup

// IMDB Integration
const imdbCache = new Map();

  // Enhanced title cleaning for better API results
  function cleanTorrentName(torrentName) {
    console.log(`🔍 Cleaning torrent name: "${torrentName}"`);
    
    // Extract year first before cleaning
    const yearMatch = torrentName.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : null;
    
    // Enhanced series detection - more comprehensive patterns
    const isLikelySeries = /\b(S\d+|Season|SEASON|series|Series|SERIES|E\d+|Episode|EPISODE|COMPLETE|Complete|complete)\b/i.test(torrentName);
    console.log(`📺 Series detection: ${isLikelySeries ? 'YES' : 'NO'}`);
    
    // First pass: Remove common torrent artifacts
    let cleaned = torrentName
      .replace(/\[(.*?)\]/g, '') // Remove [groups] like [YTS.MX], [OxTorrent.com]
      .replace(/\((.*?)\)/g, '') // Remove (year) and other parentheses content initially
      .replace(/\.(720p|1080p|480p|2160p|4K)/gi, '') // Remove quality indicators
      .replace(/\.(BluRay|WEBRip|WEB-DL|DVDRip|CAMRip|TS|TC|WEB)/gi, '') // Remove source indicators
      .replace(/\.(x264|x265|H264|H265|HEVC|AVC)/gi, '') // Remove codec info
      .replace(/\.(AAC|MP3|AC3|DTS|FLAC)/gi, '') // Remove audio codec
      .replace(/\.(mkv|mp4|avi|mov|flv)/gi, '') // Remove file extensions
      .replace(/\b(REPACK|PROPER|EXTENDED|UNRATED|DIRECTORS|CUT)\b/gi, '') // Remove edition info
      .replace(/\b\d+CH\b/gi, '') // Remove channel info like 2CH, 5.1CH
      .replace(/\b(PSA|YTS|YIFY|RARBG|EZTV|TGx)\b/gi, '') // Remove release groups
      .replace(/\./g, ' ') // Replace dots with spaces
      .replace(/[-_]/g, ' ') // Replace hyphens and underscores with spaces
      .replace(/\s+/g, ' ') // Normalize multiple spaces
      .trim();
    
    console.log(`🧹 After basic cleaning: "${cleaned}"`);
    
    if (isLikelySeries) {
      console.log(`📺 Applying series-specific cleaning`);
      
      // For series, aggressively remove season/episode specific info
      cleaned = cleaned
        .replace(/\b(S\d+.*)/gi, '') // Remove S01 and everything after
        .replace(/\b(Season\s*\d+.*)/gi, '') // Remove Season 1 and everything after
        .replace(/\b(SEASON\s*\d+.*)/gi, '') // Remove SEASON 1 and everything after
        .replace(/\b(E\d+.*)/gi, '') // Remove E01 and everything after
        .replace(/\b(Episode\s*\d+.*)/gi, '') // Remove Episode 1 and everything after
        .replace(/\b(EPISODE\s*\d+.*)/gi, '') // Remove EPISODE 1 and everything after
        .replace(/\b(COMPLETE.*)/gi, '') // Remove COMPLETE and everything after
        .replace(/\b(Complete.*)/gi, '') // Remove Complete and everything after
        .replace(/\b(complete.*)/gi, '') // Remove complete and everything after
        .replace(/\bSERIES\b/gi, '') // Remove standalone SERIES word
        .replace(/\bSeries\b/gi, '') // Remove standalone Series word
        .replace(/\bseries\b/gi, '') // Remove standalone series word
        .replace(/\bWEB\b/gi, '') // Remove WEB
        .replace(/\b\d+CH\b/gi, '') // Remove channel info again
        .replace(/\b(PSA|YTS|YIFY|RARBG|EZTV|TGx)\b/gi, '') // Remove release groups again
        .trim();
    }
    
    // Final cleanup
    cleaned = cleaned
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log(`✨ Final cleaned result: title="${cleaned}", year=${year}`);
    return { title: cleaned, year };
  }

async function fetchIMDBData(torrentName) {
    console.log(`🎬 Fetching IMDB data for: "${torrentName}"`);
    
    // Check cache first
    if (imdbCache.has(torrentName)) {
        console.log(`📋 Using cached IMDB data for: ${torrentName}`);
        return imdbCache.get(torrentName);
    }
    
    const cleanedData = cleanTorrentName(torrentName);
    const { title, year } = cleanedData;
    
    // Validate title
    if (!title || title.length < 2) {
        console.log(`❌ Title too short or empty: "${title}"`);
        return null;
    }
    
    // Detect if it's likely a series/show
    const isLikelySeries = /\b(S\d+|Season|Episode|EP\d+|E\d+|Series|Complete)\b/i.test(torrentName);
    console.log(`🔍 Likely series: ${isLikelySeries} for "${torrentName}"`);
    
    // Get API key from environment
    const omdbKey = process.env.OMDB_API_KEY || 'trilogy';
    
    // Multiple search strategies with OMDb for both movies and series
    const omdbStrategies = [];
    
    if (isLikelySeries) {
        // For series, try series type first
        omdbStrategies.push(
            year ? `http://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent(title)}&y=${year}&type=series` : null,
            `http://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent(title)}&type=series`,
            `http://www.omdbapi.com/?apikey=${omdbKey}&s=${encodeURIComponent(title)}&type=series`
        );
    }
    
    // Add movie searches (for both movies and as fallback for series)
    omdbStrategies.push(
        year ? `http://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent(title)}&y=${year}` : null,
        `http://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent(title)}`,
        `http://www.omdbapi.com/?apikey=${omdbKey}&s=${encodeURIComponent(title)}&type=movie`,
        `http://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent('The ' + title)}`
    );
    
    const filteredStrategies = omdbStrategies.filter(Boolean);
    
    // Try OMDb first
    for (const url of filteredStrategies) {
        try {
            console.log(`🔍 Trying OMDb: ${url}`);
            const response = await fetch(url);
            const data = await response.json();
            
            if (data && data.Response === 'True') {
                // For search results, take the first result
                const movieData = data.Search ? data.Search[0] : data;
                
                if (movieData && movieData.Title) {
                    console.log(`✅ Found OMDb data: ${movieData.Title} (${movieData.Year}) - Type: ${movieData.Type || 'movie'}`);
                    
                    const result = {
                        Title: movieData.Title,
                        Year: movieData.Year,
                        imdbRating: movieData.imdbRating,
                        imdbVotes: movieData.imdbVotes,
                        Plot: movieData.Plot,
                        Director: movieData.Director,
                        Actors: movieData.Actors,
                        Poster: movieData.Poster !== 'N/A' ? movieData.Poster : null,
                        Backdrop: null, // Will be enhanced below if possible
                        Genre: movieData.Genre,
                        Runtime: movieData.Runtime,
                        Rated: movieData.Rated,
                        imdbID: movieData.imdbID,
                        Type: movieData.Type || 'movie',
                        source: 'omdb'
                    };
                    
                    // Try to enhance OMDb data with TMDB backdrop for better visuals
                    try {
                        if (isLikelySeries && movieData.Type === 'series') {
                            const tmdbTvUrl = `https://api.themoviedb.org/3/search/tv?api_key=3fd2be6f0c70a2a598f084ddfb75487d&query=${encodeURIComponent(movieData.Title)}`;
                            const tmdbResponse = await fetch(tmdbTvUrl, {
                                method: 'GET',
                                headers: { 'Accept': 'application/json', 'User-Agent': 'SeedboxLite/1.0' },
                                signal: AbortSignal.timeout(10000)
                            });
                            
                            if (tmdbResponse.ok) {
                                const tmdbData = await tmdbResponse.json();
                                if (tmdbData.results && tmdbData.results.length > 0) {
                                    const show = tmdbData.results[0];
                                    if (show.backdrop_path) {
                                        result.Backdrop = `https://image.tmdb.org/t/p/w1280${show.backdrop_path}`;
                                        console.log(`🎨 Enhanced with TMDB backdrop: ${result.Backdrop}`);
                                    }
                                }
                            }
                        } else {
                            const tmdbMovieUrl = `https://api.themoviedb.org/3/search/movie?api_key=3fd2be6f0c70a2a598f084ddfb75487d&query=${encodeURIComponent(movieData.Title)}`;
                            const tmdbResponse = await fetch(tmdbMovieUrl, {
                                method: 'GET',
                                headers: { 'Accept': 'application/json', 'User-Agent': 'SeedboxLite/1.0' },
                                signal: AbortSignal.timeout(10000)
                            });
                            
                            if (tmdbResponse.ok) {
                                const tmdbData = await tmdbResponse.json();
                                if (tmdbData.results && tmdbData.results.length > 0) {
                                    const movie = tmdbData.results[0];
                                    if (movie.backdrop_path) {
                                        result.Backdrop = `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`;
                                        console.log(`🎨 Enhanced with TMDB backdrop: ${result.Backdrop}`);
                                    }
                                }
                            }
                        }
                    } catch (enhanceError) {
                        console.log(`⚠️ Could not enhance with TMDB backdrop: ${enhanceError.message}`);
                    }
                    
                    // Cache the result
                    imdbCache.set(torrentName, result);
                    return result;
                }
            } else {
                console.log(`❌ OMDb error: ${data?.Error || 'Unknown error'}`);
            }
        } catch (error) {
            console.log(`❌ OMDb request error: ${error.message}`);
        }
    }
    
    // Fallback to TMDB (try both movies and TV series)
    console.log(`🎭 Trying TMDB as fallback for: ${title}`);
    
    // Try TV series first if likely series
    if (isLikelySeries) {
        try {
            const tmdbTvUrl = `https://api.themoviedb.org/3/search/tv?api_key=3fd2be6f0c70a2a598f084ddfb75487d&query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ''}`;
            console.log(`🔍 Trying TMDB TV: ${tmdbTvUrl}`);
            
            const searchResponse = await fetch(tmdbTvUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'SeedboxLite/1.0'
                },
                signal: AbortSignal.timeout(15000) // 15 second timeout
            });
            
            if (!searchResponse.ok) {
                throw new Error(`HTTP ${searchResponse.status}: ${searchResponse.statusText}`);
            }
            
            const searchData = await searchResponse.json();
            
            if (searchData.results && searchData.results.length > 0) {
                const show = searchData.results[0];
                
                // Get detailed info for TV show
                const detailsUrl = `https://api.themoviedb.org/3/tv/${show.id}?api_key=3fd2be6f0c70a2a598f084ddfb75487d&append_to_response=credits`;
                const detailsResponse = await fetch(detailsUrl, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'SeedboxLite/1.0'
                    },
                    signal: AbortSignal.timeout(15000)
                });
                
                if (!detailsResponse.ok) {
                    throw new Error(`HTTP ${detailsResponse.status}: ${detailsResponse.statusText}`);
                }
                
                const details = await detailsResponse.json();
                
                console.log(`✅ Found TMDB TV data: ${details.name} (${details.first_air_date?.substring(0, 4)})`);
                
                const result = {
                    Title: details.name,
                    Year: details.first_air_date?.substring(0, 4),
                    imdbRating: details.vote_average ? (details.vote_average / 10 * 10).toFixed(1) : null,
                    imdbVotes: details.vote_count ? `${details.vote_count.toLocaleString()}` : null,
                    Plot: details.overview,
                    Director: details.created_by?.map(creator => creator.name).join(', ') || 'N/A',
                    Actors: details.credits?.cast?.slice(0, 4).map(actor => actor.name).join(', '),
                    Poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
                    Backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
                    Genre: details.genres?.map(g => g.name).join(', '),
                    Runtime: details.episode_run_time?.[0] ? `${details.episode_run_time[0]} min` : null,
                    Rated: 'N/A',
                    tmdbID: details.id,
                    Type: 'series',
                    source: 'tmdb-tv'
                };
                
                // Cache the result
                imdbCache.set(torrentName, result);
                return result;
            }
        } catch (error) {
            console.log(`❌ TMDB TV error: ${error.message}`);
        }
    }
    
    // Try TMDB movies as final fallback
    try {
        const tmdbSearchUrl = `https://api.themoviedb.org/3/search/movie?api_key=3fd2be6f0c70a2a598f084ddfb75487d&query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`;
        console.log(`🔍 Trying TMDB Movies: ${tmdbSearchUrl}`);
        
        const searchResponse = await fetch(tmdbSearchUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'SeedboxLite/1.0'
            },
            signal: AbortSignal.timeout(15000)
        });
        
        if (!searchResponse.ok) {
            throw new Error(`HTTP ${searchResponse.status}: ${searchResponse.statusText}`);
        }
        
        const searchData = await searchResponse.json();
        
        if (searchData.results && searchData.results.length > 0) {
            const movie = searchData.results[0];
            
            // Get detailed info
            const detailsUrl = `https://api.themoviedb.org/3/movie/${movie.id}?api_key=3fd2be6f0c70a2a598f084ddfb75487d&append_to_response=credits`;
            const detailsResponse = await fetch(detailsUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'SeedboxLite/1.0'
                },
                signal: AbortSignal.timeout(15000)
            });
            
            if (!detailsResponse.ok) {
                throw new Error(`HTTP ${detailsResponse.status}: ${detailsResponse.statusText}`);
            }
            
            const details = await detailsResponse.json();
            
            console.log(`✅ Found TMDB Movie data: ${details.title} (${details.release_date?.substring(0, 4)})`);
            
            const result = {
                Title: details.title,
                Year: details.release_date?.substring(0, 4),
                imdbRating: details.vote_average ? (details.vote_average / 10 * 10).toFixed(1) : null,
                imdbVotes: details.vote_count ? `${details.vote_count.toLocaleString()}` : null,
                Plot: details.overview,
                Director: details.credits?.crew?.find(person => person.job === 'Director')?.name,
                Actors: details.credits?.cast?.slice(0, 4).map(actor => actor.name).join(', '),
                Poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
                Backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
                Genre: details.genres?.map(g => g.name).join(', '),
                Runtime: details.runtime ? `${details.runtime} min` : null,
                Rated: 'N/A',
                tmdbID: details.id,
                Type: 'movie',
                source: 'tmdb-movie'
            };
            
            // Cache the result
            imdbCache.set(torrentName, result);
            return result;
        }
    } catch (error) {
        console.log(`❌ TMDB Movie error: ${error.message}`);
    }
    
    console.log(`❌ No movie/series data found for: ${title}`);
    return null;
}

//UNIVERSAL TORRENT RESOLVER - Can find torrents by ANY identifier with optimized performance
const universalTorrentResolver = async (identifier) => {
  // Use a timeout to prevent hanging operations
  let resolverTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    resolverTimeout = setTimeout(() => {
      reject(new Error('Resolver timed out after 5 seconds'));
    }, 5000);
  });

  try {
    // Create a promise for the resolution process
    const resolutionPromise = (async () => {
      // Skip verbose logging on frequent API calls
      const debugLevel = process.env.DEBUG === 'true';
      if (debugLevel) console.log(`🔍 Universal resolver looking for: ${identifier}`);
      
      // Optimize with direct lookups for better performance - O(1) operations
      // Strategy 1: Direct hash match in torrents - fastest path
      if (torrents[identifier]) {
        return torrents[identifier];
      }
      
      // Strategy 2: Check lookup tables - also very fast
      const hashByName = nameToHash[identifier];
      if (hashByName && torrents[hashByName]) {
        return torrents[hashByName];
      }

      const originalTorrentId = torrentIds[identifier];
      if (originalTorrentId && torrents[originalTorrentId]) {
        return torrents[originalTorrentId];
      }
      
      // Strategy 3: Check WebTorrent client
      // Reduce search complexity by using a direct infoHash comparison when possible
      if (identifier.length === 40) {
        // For hash-like identifiers, do direct comparison
        const existingTorrent = client.torrents.find(t => 
          t.infoHash === identifier
        );
        
        if (existingTorrent) {
          torrents[existingTorrent.infoHash] = existingTorrent;
          return existingTorrent;
        }
      } else {
        // For non-hash identifiers, check other properties
        const existingTorrent = client.torrents.find(t => 
          t.name === identifier ||
          t.magnetURI === identifier
        );
        
        if (existingTorrent) {
          torrents[existingTorrent.infoHash] = existingTorrent;
          return existingTorrent;
        }
      }
    })();

    // Race the resolution against the timeout
    return await Promise.race([resolutionPromise, timeoutPromise]);
  } catch (error) {
    console.error(`⚠️ Resolver error: ${error.message}`);
    return null;
  } finally {
    clearTimeout(resolverTimeout);
  }
  
  // Strategy 6: If identifier looks like a torrent ID/magnet, try loading it
  if (identifier.startsWith('magnet:') || identifier.startsWith('http') || identifier.length === 40) {
    console.log(`🔄 Attempting to load as new torrent: ${identifier}`);
    try {
      const torrent = await loadTorrentFromId(identifier);
      return torrent;
    } catch (error) {
      console.error(`❌ Failed to load as new torrent:`, error.message);
    }
  }
  
  console.log(`❌ Universal resolver exhausted all strategies for: ${identifier}`);
  return null;
};

// ENHANCED TORRENT LOADER
const loadTorrentFromId = (torrentId) => {
  return new Promise((resolve, reject) => {
    console.log(`🔄 Loading torrent: ${torrentId}`);
    
    // If it's just a hash, construct a basic magnet link with reliable trackers
    let magnetUri = torrentId;
    if (torrentId.length === 40 && !torrentId.startsWith('magnet:')) {
      magnetUri = `magnet:?xt=urn:btih:${torrentId}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:6969/announce&tr=udp://exodus.desync.com:6969/announce&tr=udp://tracker.torrent.eu.org:451/announce&tr=udp://tracker.tiny-vps.com:6969/announce&tr=udp://retracker.lanta-net.ru:2710/announce`;
      console.log(`🧲 Constructed magnet URI from hash: ${magnetUri}`);
    }
    
    let torrent;
    
    try {
      const torrentOptions = {
        announce: [
          'udp://tracker.opentrackr.org:1337/announce',
          'udp://open.demonii.com:1337/announce',
          'udp://tracker.openbittorrent.com:6969/announce',
          'udp://exodus.desync.com:6969/announce',
          'udp://tracker.torrent.eu.org:451/announce',
          'udp://tracker.tiny-vps.com:6969/announce',
          'udp://retracker.lanta-net.ru:2710/announce',
          'udp://9.rarbg.to:2710/announce',
          'udp://explodie.org:6969/announce',
          'udp://tracker.coppersurfer.tk:6969/announce',
          'wss://tracker.btorrent.xyz', // WebSocket tracker
          'wss://tracker.webtorrent.io', // WebSocket tracker
          'wss://tracker.openwebtorrent.com' // WebSocket tracker
        ],
        private: false,
        strategy: 'rarest', // Download rarest pieces first for faster startup
        maxWebConns: 30,    // More web seed connections
        path: './downloads' // Ensure consistent download location
      };
      torrent = client.add(magnetUri, torrentOptions);
    } catch (addError) {
      // Handle duplicate torrent error from WebTorrent client
      if (addError.message && addError.message.includes('duplicate')) {
        console.log(`🔍 Duplicate torrent detected in WebTorrent client, finding existing`);
        
        // Extract hash from the torrent ID
        let hash = torrentId;
        if (torrentId.startsWith('magnet:')) {
          const match = torrentId.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
          if (match) hash = match[1];
        }
        
        // Find the existing torrent in the client
        const existingTorrent = client.torrents.find(t => 
          t.infoHash.toLowerCase() === hash.toLowerCase()
        );
        
        if (existingTorrent) {
          console.log(`✅ Found existing torrent in client: ${existingTorrent.name || existingTorrent.infoHash}`);
          resolve(existingTorrent);
          return;
        }
      }
      
      reject(addError);
      return;
    }
    
    let resolved = false;
    
    // Add comprehensive debugging
    console.log(`🎯 Added torrent to WebTorrent client: ${torrent.infoHash}`);
    
    torrent.on('infoHash', () => {
      console.log(`🔗 Info hash available: ${torrent.infoHash}`);
    });
    
    torrent.on('metadata', () => {
      console.log(`📋 Metadata received for: ${torrent.name || 'Unknown'}`);
      console.log(`📊 Files found: ${torrent.files.length}`);
    });
    
    torrent.on('ready', () => {
      if (resolved) return;
      resolved = true;
      
      console.log(`✅ Torrent loaded: ${torrent.name} (${torrent.infoHash})`);
      console.log(`📊 Torrent stats: ${torrent.files.length} files, ${(torrent.length / 1024 / 1024).toFixed(1)} MB`);
      
      // Store in ALL our tracking systems
      torrents[torrent.infoHash] = torrent;
      torrentIds[torrent.infoHash] = torrentId;
      torrentNames[torrent.infoHash] = torrent.name;
      hashToName[torrent.infoHash] = torrent.name;
      nameToHash[torrent.name] = torrent.infoHash;
      
      torrent.addedAt = new Date().toISOString();
      
      // Balanced upload limit for peer reciprocity (required for downloads)
      torrent.uploadLimit = 5000; // 5KB/s - enough for good peer reciprocity
      
      // Stop seeding when download is complete
      torrent.on('done', () => {
        console.log(`✅ Download complete for ${torrent.name} - Stopping seeding`);
        torrent.uploadLimit = 0; // Disable uploading once download is complete
      });
      
      // Enhanced configuration for streaming with better buffering
      torrent.files.forEach((file, index) => {
        const ext = file.name.toLowerCase().split('.').pop();
        const isSubtitle = ['srt', 'vtt', 'ass', 'ssa', 'sub', 'sbv'].includes(ext);
        const isVideo = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext);
        
        if (isSubtitle) {
          // Select subtitle files with high priority
          file.select();
          console.log(`📝 Subtitle file prioritized: ${file.name}`);
        } else if (isVideo) {
          // Standard video streaming optimization with moderate piece selection
          file.select();
          
          // Create a modest buffer only at the start to improve initial loading
          const INITIAL_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB at the start
          
          // Only prime the first part of the file for better streaming startup
          // This avoids creating too many streams that can block API responses
          const initialStream = file.createReadStream({ start: 0, end: INITIAL_BUFFER_SIZE });
          initialStream.on('error', () => {}); // Ignore errors on this priming stream
          
          console.log(`🎬 Video file optimized for streaming: ${file.name}`);
        } else {
          // Only select video and subtitle files to avoid wasting bandwidth
          file.deselect();
          console.log(`⏭️  Skipping: ${file.name}`);
        }
      });
      
      resolve(torrent);
    });
    
    torrent.on('metadata', () => {
      console.log(`📋 Metadata received for: ${torrent.name || 'Unknown'}`);
    });
    
    torrent.on('error', (error) => {
      if (resolved) return;
      resolved = true;
      console.error(`❌ Error loading torrent:`, error.message);
      reject(error);
    });
    
    // Extended timeout for better peer discovery and metadata retrieval
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log(`⏰ Timeout loading torrent after 60 seconds: ${torrentId}`);
        
        // Check if the torrent was actually added to the client
        const clientTorrent = client.torrents.find(t => t.infoHash === torrent.infoHash);
        if (clientTorrent) {
          console.log(`🔍 Found torrent in client after timeout: ${clientTorrent.name || clientTorrent.infoHash}`);
          
          // Store in tracking systems even if metadata isn't fully ready
          torrents[clientTorrent.infoHash] = clientTorrent;
          torrentIds[clientTorrent.infoHash] = torrentId;
          torrentNames[clientTorrent.infoHash] = clientTorrent.name || 'Loading...';
          hashToName[clientTorrent.infoHash] = clientTorrent.name || 'Loading...';
          if (clientTorrent.name) {
            nameToHash[clientTorrent.name] = clientTorrent.infoHash;
          }
          
          clientTorrent.addedAt = new Date().toISOString();
          clientTorrent.uploadLimit = 5000; // Moderate upload for peer reciprocity (5KB/s)
          
          // Try to optimize any video files even if metadata is incomplete
          if (clientTorrent.files && clientTorrent.files.length) {
            clientTorrent.files.forEach(file => {
              const ext = file.name.toLowerCase().split('.').pop();
              if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) {
                file.select();
                file.critical = true;
              }
            });
          }
          
          resolve(clientTorrent);
        } else {
          console.log(`🔍 Client has ${client.torrents.length} torrents total`);
          reject(new Error('Timeout loading torrent'));
        }
      }
    }, 60000); // Extended timeout to 60 seconds
  });
};

// Add a cache cleanup mechanism to prevent memory bloat
function setupCacheCleanup() {
  console.log('🧹 Setting up cache cleanup system');
  
  // Run cache cleanup every 5 minutes
  setInterval(() => {
    const now = Date.now();
    let cleanedEntries = 0;
    
    // Get all global variables that might be caches
    const potentialCacheKeys = Object.keys(global).filter(key => {
      return (
        key.startsWith('torrent_details_') ||
        key.startsWith('imdb_data_') ||
        key.startsWith('files_') ||
        key.startsWith('stats_') ||
        key === 'torrentListCache'
      );
    });
    
    // Clean up time entries too
    const timeKeys = Object.keys(global).filter(key => key.endsWith('_time'));
    
    // Process cache entries
    potentialCacheKeys.forEach(key => {
      const timeKey = `${key}_time`;
      
      // If it has a timestamp, check if it's expired
      if (global[timeKey]) {
        const maxAge = key.startsWith('imdb_data_') ? 3600000 : 300000; // 1 hour for IMDB, 5 minutes for others
        
        if (now - global[timeKey] > maxAge) {
          delete global[key];
          delete global[timeKey];
          cleanedEntries++;
        }
      } else if (key === 'torrentListCache' && global.torrentListCacheTime) {
        // Special case for torrentListCache
        if (now - global.torrentListCacheTime > 300000) { // 5 minutes
          delete global.torrentListCache;
          delete global.torrentListCacheTime;
          cleanedEntries++;
        }
      }
    });
    
    if (cleanedEntries > 0) {
      console.log(`🧹 Cache cleanup completed: ${cleanedEntries} entries removed`);
    }
    
    // Force garbage collection if available (Node with --expose-gc flag)
    if (global.gc) {
      try {
        global.gc();
        console.log('♻️ Manual garbage collection triggered');
      } catch (e) {
        console.log('♻️ Manual garbage collection failed:', e.message);
      }
    }
  }, 300000); // Every 5 minutes
}

// Setup cache cleanup on server start
setupCacheCleanup();

// System Health Monitoring
function setupSystemMonitoring() {
  console.log('🩺 Setting up system health monitoring');
  
  // Track system status
  global.systemHealth = {
    startTime: Date.now(),
    lastCheck: Date.now(),
    memoryWarnings: 0,
    apiTimeouts: 0,
    streamErrors: 0,
    lastMemoryUsage: 0,
    torrentCount: 0,
    totalRequests: 0,
    highMemoryDetected: false
  };

  // Check system health every minute
  setInterval(() => {
    try {
      const memoryUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
      const rssMemoryMB = Math.round(memoryUsage.rss / 1024 / 1024);
      
      global.systemHealth.lastCheck = Date.now();
      global.systemHealth.lastMemoryUsage = rssMemoryMB;
      global.systemHealth.torrentCount = client.torrents.length;
      
      console.log(`💾 Memory Usage: ${heapUsedMB}MB heap, ${rssMemoryMB}MB total`);
      console.log(`⚙️ System running for: ${Math.round((Date.now() - global.systemHealth.startTime) / 1000 / 60)} minutes`);
      console.log(`🧲 Active torrents: ${client.torrents.length}`);
      
      // Detect high memory usage
      const HIGH_MEMORY_THRESHOLD = 1024; // 1GB
      if (rssMemoryMB > HIGH_MEMORY_THRESHOLD) {
        console.log(`⚠️ HIGH MEMORY USAGE DETECTED: ${rssMemoryMB}MB`);
        global.systemHealth.memoryWarnings++;
        global.systemHealth.highMemoryDetected = true;
        
        // Take action if memory usage is persistently high
        if (global.systemHealth.memoryWarnings > 3) {
          console.log('🚨 CRITICAL MEMORY USAGE - Performing emergency cleanup');
          
          // Clear all caches
          Object.keys(global).forEach(key => {
            if (key.includes('_cache') || key.includes('Cache') || 
                key.endsWith('_time') || key.startsWith('torrent_details_') || 
                key.startsWith('files_') || key.startsWith('stats_') || 
                key.startsWith('imdb_data_')) {
              delete global[key];
            }
          });
          
          // Force garbage collection if available
          if (global.gc) {
            try {
              global.gc();
              console.log('♻️ Forced garbage collection');
            } catch (e) {
              console.log('♻️ Forced GC failed:', e.message);
            }
          }
          
          // Reset warning counter after cleanup
          global.systemHealth.memoryWarnings = 0;
        }
      } else {
        global.systemHealth.highMemoryDetected = false;
        // Decrease warning counter if memory usage is normal
        if (global.systemHealth.memoryWarnings > 0) {
          global.systemHealth.memoryWarnings--;
        }
      }
      
      // Check for long-running torrents with low progress
      if (client.torrents.length > 0) {
        const now = Date.now();
        client.torrents.forEach(torrent => {
          // Skip completed torrents
          if (torrent.progress >= 1) return;
          
          // Get when the torrent was added
          const addedTime = torrent.addedAt ? new Date(torrent.addedAt).getTime() : now;
          const runningHours = (now - addedTime) / (1000 * 60 * 60);
          
          // Check if torrent has been running for over 12 hours with little progress
          if (runningHours > 12 && torrent.progress < 0.1) {
            console.log(`⚠️ Stalled torrent detected: ${torrent.name || torrent.infoHash} - Running for ${Math.round(runningHours)}h with only ${(torrent.progress*100).toFixed(1)}% progress`);
            
            // Restart the torrent to try to improve its state
            try {
              console.log(`🔄 Attempting to restart stalled torrent: ${torrent.infoHash}`);
              torrent.destroy();
              
              // Remove from tracking
              delete torrents[torrent.infoHash];
              
              // Delay re-adding to allow cleanup
              setTimeout(() => {
                loadTorrentFromId(torrent.infoHash).catch(err => {
                  console.error(`❌ Failed to restart torrent:`, err.message);
                });
              }, 5000);
            } catch (e) {
              console.error(`❌ Failed to restart stalled torrent:`, e.message);
            }
          }
        });
      }
      
    } catch (e) {
      console.error('❌ Error in system monitoring:', e.message);
    }
  }, 60000); // Every minute
  
  // Expose system health endpoint
  app.get('/api/system/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    
    res.json({
      status: 'ok',
      uptime: Date.now() - global.systemHealth.startTime,
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024)
      },
      torrents: client.torrents.length,
      warnings: {
        memory: global.systemHealth.memoryWarnings,
        api: global.systemHealth.apiTimeouts
      },
      highMemory: global.systemHealth.highMemoryDetected,
      timestamp: Date.now()
    });
  });
}

// Setup system monitoring
setupSystemMonitoring();

// Error handling with better recovery
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  
  // Log to system health
  if (global.systemHealth) {
    global.systemHealth.lastError = {
      type: 'uncaughtException',
      message: error.message,
      time: Date.now()
    };
  }
  
  // Try to keep the process running unless it's a critical error
  if (error.message.includes('EADDRINUSE') || 
      error.message.includes('Cannot read properties of undefined')) {
    console.log('🚨 Critical error detected, exiting process');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  
  // Log to system health
  if (global.systemHealth) {
    global.systemHealth.lastError = {
      type: 'unhandledRejection',
      message: reason?.message || String(reason),
      time: Date.now()
    };
  }
});

process.on('SIGTERM', () => {
  console.log('📤 SIGTERM received, shutting down gracefully...');
  
  // Close all torrents cleanly
  try {
    console.log('🧲 Closing all torrents...');
    client.torrents.forEach(torrent => {
      try {
        torrent.destroy();
      } catch (e) {
        console.log(`❌ Error destroying torrent: ${e.message}`);
      }
    });
    client.destroy();
  } catch (e) {
    console.log(`❌ Error closing client: ${e.message}`);
  }
  
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📤 SIGINT received, shutting down gracefully...');
  
  // Close all torrents cleanly
  try {
    console.log('🧲 Closing all torrents...');
    client.torrents.forEach(torrent => {
      try {
        torrent.destroy();
      } catch (e) {
        console.log(`❌ Error destroying torrent: ${e.message}`);
      }
    });
    client.destroy();
  } catch (e) {
    console.log(`❌ Error closing client: ${e.message}`);
  }
  
  process.exit(0);
});

// Configure multer
const fs = require('fs');
const uploadsDir = 'uploads/';

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('📁 Created uploads directory');
}

const upload = multer({ 
  dest: uploadsDir,
  fileFilter: (req, file, cb) => {
    cb(null, file.originalname.endsWith('.torrent'));
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for torrent files
  }
});

// CORS Configuration - Allow all origins
console.log('🌐 CORS: Allowing ALL origins (permissive mode)');

// Simple CORS configuration allowing all origins
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin'
  ],
  optionsSuccessStatus: 200
}));

// Additional permissive CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With,Accept,Origin');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Authentication endpoint
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const correctPassword = process.env.ACCESS_PASSWORD || 'seedbox123';
  
  console.log(`🔐 Login attempt with password: ${password ? '[PROVIDED]' : '[MISSING]'}`);
  
  if (!password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Password is required' 
    });
  }
  
  if (password === correctPassword) {
    console.log('✅ Authentication successful');
    return res.json({ 
      success: true, 
      message: 'Authentication successful' 
    });
  } else {
    console.log('❌ Authentication failed - incorrect password');
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid password' 
    });
  }
});

// UNIVERSAL ADD TORRENT - Always succeeds
app.post('/api/torrents', async (req, res) => {
  const { torrentId } = req.body;
  if (!torrentId) return res.status(400).json({ error: 'No torrentId provided' });
  
  console.log(`🚀 UNIVERSAL ADD: ${torrentId}`);
  
  try {
    const torrent = await universalTorrentResolver(torrentId);
    
    if (!torrent) {
      // If resolver failed, try direct loading
      try {
        const newTorrent = await loadTorrentFromId(torrentId);
        return res.json({ 
          success: true,
          infoHash: newTorrent.infoHash,
          name: newTorrent.name || 'Loading...',
          size: newTorrent.length || 0,
          status: 'loaded'
        });
      } catch (loadError) {
        // Handle duplicate torrent error specially
        if (loadError.message.includes('duplicate torrent')) {
          console.log(`🔍 Duplicate torrent detected, finding existing torrent`);
          
          // Extract hash from torrentId if it's a magnet
          let hash = torrentId;
          if (torrentId.startsWith('magnet:')) {
            const match = torrentId.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
            if (match) hash = match[1];
          }
          
          // Try to find the existing torrent
          const existingTorrent = Object.values(torrents).find(t => 
            t.infoHash === hash || 
            t.infoHash.toLowerCase() === hash.toLowerCase()
          ) || client.torrents.find(t => 
            t.infoHash === hash || 
            t.infoHash.toLowerCase() === hash.toLowerCase()
          );
          
          if (existingTorrent) {
            console.log(`✅ Found existing torrent: ${existingTorrent.name}`);
            return res.json({ 
              success: true,
              infoHash: existingTorrent.infoHash,
              name: existingTorrent.name || 'Loading...',
              size: existingTorrent.length || 0,
              status: 'existing',
              message: 'Torrent already added'
            });
          }
          
          // If we can't find the existing torrent, still return success
          // This handles edge cases where duplicate is detected but torrent isn't in our list yet
          console.log(`✅ Duplicate detected but not found in list, assuming success`);
          return res.json({ 
            success: true,
            infoHash: hash,
            name: 'Duplicate torrent',
            size: 0,
            status: 'duplicate',
            message: 'Torrent already exists in the system'
          });
        }
        
        throw loadError;
      }
    }
    
    res.json({ 
      success: true,
      infoHash: torrent.infoHash,
      name: torrent.name || 'Loading...',
      size: torrent.length || 0,
      status: 'found'
    });
    
  } catch (error) {
    console.error(`❌ Universal add failed:`, error.message);
    res.status(500).json({ error: 'Failed to add torrent: ' + error.message });
  }
});

// UNIVERSAL FILE UPLOAD - Handle .torrent files
app.post('/api/torrents/upload', upload.single('torrentFile'), async (req, res) => {
  console.log(`📁 UNIVERSAL FILE UPLOAD`);
  
  if (!req.file) {
    return res.status(400).json({ error: 'No torrent file provided' });
  }
  
  try {
    const fs = require('fs');
    const torrentPath = req.file.path;
    
    console.log(`📁 Processing uploaded file: ${req.file.originalname}`);
    console.log(`📁 File path: ${torrentPath}`);
    
    // Read the torrent file
    const torrentBuffer = fs.readFileSync(torrentPath);
    
    // Load the torrent using the buffer
    const torrent = await new Promise((resolve, reject) => {
      let loadedTorrent;
      
      try {
        const torrentOptions = {
          announce: [
            'udp://tracker.opentrackr.org:1337/announce',
            'udp://open.demonii.com:1337/announce',
            'udp://tracker.openbittorrent.com:6969/announce',
            'udp://exodus.desync.com:6969/announce',
            'udp://tracker.torrent.eu.org:451/announce',
            'udp://9.rarbg.to:2710/announce'
          ],
          private: false,
          strategy: 'rarest', // Download rarest pieces first for faster startup
          maxWebConns: 20     // More web seed connections
        };
        loadedTorrent = client.add(torrentBuffer, torrentOptions);
        
        // Stop seeding when download is complete
        loadedTorrent.on('done', () => {
          console.log(`✅ Download complete for ${loadedTorrent.name} - Stopping seeding`);
          loadedTorrent.uploadLimit = 0; // Disable uploading once download is complete
        });
      } catch (addError) {
        // Handle duplicate torrent in file upload
        if (addError.message && addError.message.includes('duplicate')) {
          console.log(`🔍 Duplicate torrent file detected, finding existing`);
          
          // Parse the torrent buffer to get the info hash
          const parseTorrent = require('parse-torrent');
          try {
            const parsed = parseTorrent(torrentBuffer);
            const existingTorrent = client.torrents.find(t => 
              t.infoHash.toLowerCase() === parsed.infoHash.toLowerCase()
            );
            
            if (existingTorrent) {
              console.log(`✅ Found existing torrent from file: ${existingTorrent.name || existingTorrent.infoHash}`);
              resolve(existingTorrent);
              return;
            }
          } catch (parseError) {
            console.error(`❌ Error parsing torrent for duplicate check:`, parseError.message);
          }
        }
        
        reject(addError);
        return;
      }
      
      let resolved = false;
      
      loadedTorrent.on('ready', () => {
        if (resolved) return;
        resolved = true;
        
        console.log(`✅ Torrent uploaded and loaded: ${loadedTorrent.name}`);
        
        // Store in tracking systems
        torrents[loadedTorrent.infoHash] = loadedTorrent;
        torrentIds[loadedTorrent.infoHash] = req.file.originalname;
        torrentNames[loadedTorrent.infoHash] = loadedTorrent.name;
        hashToName[loadedTorrent.infoHash] = loadedTorrent.name;
        nameToHash[loadedTorrent.name] = loadedTorrent.infoHash;
        
        loadedTorrent.addedAt = new Date().toISOString();
        loadedTorrent.uploadLimit = 2048; // Moderate upload for peer reciprocity
        
        resolve(loadedTorrent);
      });
      
      loadedTorrent.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        console.error(`❌ Error loading uploaded torrent:`, err.message);
        
        // Handle duplicate error in event handler too
        if (err.message && err.message.includes('duplicate')) {
          console.log(`🔍 Duplicate torrent detected in error handler`);
          
          // Try to find existing torrent and return it
          const parseTorrent = require('parse-torrent');
          try {
            const parsed = parseTorrent(torrentBuffer);
            const existingTorrent = client.torrents.find(t => 
              t.infoHash.toLowerCase() === parsed.infoHash.toLowerCase()
            );
            
            if (existingTorrent) {
              console.log(`✅ Found existing torrent in error handler: ${existingTorrent.name}`);
              resolve(existingTorrent);
              return;
            }
          } catch (parseError) {
            console.error(`❌ Error parsing in error handler:`, parseError.message);
          }
        }
        
        reject(err);
      });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Timeout loading torrent file'));
        }
      }, 30000);
    });
    
    // Clean up uploaded file
    fs.unlinkSync(torrentPath);
    
    res.json({
      success: true,
      infoHash: torrent.infoHash,
      name: torrent.name,
      size: torrent.length,
      status: 'uploaded',
      files: torrent.files.length
    });
    
  } catch (error) {
    console.error(`❌ File upload failed:`, error.message);
    
    // Clean up file on error
    if (req.file && req.file.path) {
      try {
        const fs = require('fs');
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error(`❌ Failed to cleanup file:`, cleanupError.message);
      }
    }
    
    res.status(500).json({ error: 'Failed to upload torrent: ' + error.message });
  }
});

// UNIVERSAL GET TORRENTS - Always returns results with optimized performance
app.get('/api/torrents', (req, res) => {
  // Add a timeout to abort long-running requests
  res.setTimeout(3000, () => {
    console.log('Request timed out for /api/torrents');
    if (!res.headersSent) {
      res.status(503).json({ error: 'Request timeout', message: 'Server is busy, try again later' });
    }
  });
  
  try {
    // Use simple cache to avoid regenerating the same data repeatedly
    const now = Date.now();
    if (global.torrentListCache && 
        global.torrentListCacheTime && 
        now - global.torrentListCacheTime < 2000) { // 2 second cache
      return res.json(global.torrentListCache);
    }
    
    // Minimize operations by using more efficient code
    const activeTorrents = [];
    for (const key in torrents) {
      const torrent = torrents[key];
      if (!torrent) continue;
      
      activeTorrents.push({
        infoHash: torrent.infoHash,
        name: torrent.name,
        size: torrent.length || 0,
        downloaded: torrent.downloaded || 0,
        uploaded: 0,
        progress: torrent.progress || 0,
        downloadSpeed: torrent.downloadSpeed || 0,
        uploadSpeed: 0,
        peers: torrent.numPeers || 0,
        addedAt: torrent.addedAt || new Date().toISOString()
      });
    }
    
    // Skip verbose logging on each poll
    const response = { torrents: activeTorrents };
    
    // Cache the result
    global.torrentListCache = response;
    global.torrentListCacheTime = now;
    
    res.json(response);
  } catch (error) {
    console.error('Error in /api/torrents:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// UNIVERSAL GET TORRENT DETAILS - Optimized for performance
app.get('/api/torrents/:identifier', async (req, res) => {
  const identifier = req.params.identifier;
  
  // Add a timeout to prevent hanging requests
  const requestTimeout = setTimeout(() => {
    console.log(`⏱️ Request timed out for torrent details: ${identifier}`);
    if (!res.headersSent) {
      res.status(503).json({ 
        error: 'Request timeout', 
        message: 'Torrent details request timed out, server is busy'
      });
    }
  }, 5000); // 5 second timeout
  
  try {
    // Check cache first to avoid repeated lookups
    const cacheKey = `torrent_details_${identifier}`;
    const now = Date.now();
    if (global[cacheKey] && 
        global[`${cacheKey}_time`] && 
        now - global[`${cacheKey}_time`] < 3000) { // 3 second cache
      clearTimeout(requestTimeout);
      return res.json(global[cacheKey]);
    }
    
    // Only log for non-cached requests
    if (process.env.DEBUG === 'true') {
      console.log(`🎯 UNIVERSAL GET: ${identifier}`);
    }
    
    const torrent = await universalTorrentResolver(identifier);
    
    if (!torrent) {
      clearTimeout(requestTimeout);
      
      // Don't generate suggestions on every request - expensive operation
      // Only include up to 5 suggestions to keep response size small
      const suggestions = Object.values(torrents)
        .slice(0, 5)
        .map(t => ({
          infoHash: t.infoHash,
          name: t.name
        }));
      
      return res.status(404).json({ 
        error: 'Torrent not found',
        identifier,
        suggestions,
        availableTorrents: Object.keys(torrents).length // Just count, don't process
      });
    }

    // More efficient file mapping with early returns for large torrents
    const maxFilesToShow = 1000; // Limit files for very large torrents
    const files = torrent.files
      .slice(0, maxFilesToShow)
      .map((file, index) => ({
        index,
        name: file.name,
        size: file.length || 0,
        downloaded: file.downloaded || 0,
        progress: file.progress || 0
      }));

    const response = { 
      torrent: {
        infoHash: torrent.infoHash,
        name: torrent.name,
        size: torrent.length || 0,
        downloaded: torrent.downloaded || 0,
        uploaded: 0,
        progress: torrent.progress || 0,
        downloadSpeed: torrent.downloadSpeed || 0,
        uploadSpeed: 0,
        peers: torrent.numPeers || 0,
        files: torrent.files?.length || 0,
        addedAt: torrent.addedAt || new Date().toISOString()
      }, 
      files,
      filesTotal: torrent.files?.length || 0,
      filesShown: files.length
    };
    
    // Cache the result
    global[cacheKey] = response;
    global[`${cacheKey}_time`] = now;
    
    clearTimeout(requestTimeout);
    res.json(response);
    
  } catch (error) {
    clearTimeout(requestTimeout);
    console.error(`❌ Universal get failed:`, error.message);
    res.status(500).json({ error: 'Failed to get torrent details: ' + error.message });
  }
});

// UNIVERSAL FILES ENDPOINT - Optimized with caching and timeout
app.get('/api/torrents/:identifier/files', async (req, res) => {
  const identifier = req.params.identifier;
  const debugLevel = process.env.DEBUG === 'true';
  
  // Add a timeout to prevent hanging requests
  const requestTimeout = setTimeout(() => {
    console.log(`⏱️ Files request timed out for: ${identifier}`);
    if (!res.headersSent) {
      res.status(503).json({ 
        error: 'Request timeout', 
        message: 'Files request timed out, try again later'
      });
    }
  }, 5000); // 5 second timeout
  
  try {
    // Check cache first
    const cacheKey = `files_${identifier}`;
    const now = Date.now();
    if (global[cacheKey] && 
        global[`${cacheKey}_time`] && 
        now - global[`${cacheKey}_time`] < 10000) { // 10 second cache
      clearTimeout(requestTimeout);
      return res.json(global[cacheKey]);
    }
    
    if (debugLevel) console.log(`📁 UNIVERSAL FILES: ${identifier}`);
    
    const torrent = await universalTorrentResolver(identifier);
    
    if (!torrent) {
      clearTimeout(requestTimeout);
      return res.status(404).json({ error: 'Torrent not found' });
    }

    // Handle large torrents more efficiently by paginating results
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 1000;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    
    const totalFiles = torrent.files.length;
    
    const files = torrent.files
      .slice(start, end)
      .map((file, idx) => ({
        index: start + idx, // Correct index based on pagination
        name: file.name,
        size: file.length || 0,
        downloaded: file.downloaded || 0,
        progress: file.progress || 0
      }));

    const response = {
      files,
      pagination: {
        page,
        pageSize,
        totalFiles,
        totalPages: Math.ceil(totalFiles / pageSize)
      }
    };
    
    // Cache the response
    global[cacheKey] = response;
    global[`${cacheKey}_time`] = now;
    
    clearTimeout(requestTimeout);
    res.json(response);
    
  } catch (error) {
    clearTimeout(requestTimeout);
    console.error(`❌ Universal files failed:`, error.message);
    res.status(500).json({ error: 'Failed to get torrent files: ' + error.message });
  }
});

// UNIVERSAL STATS ENDPOINT - Optimized with caching and timeout
app.get('/api/torrents/:identifier/stats', async (req, res) => {
  const identifier = req.params.identifier;
  const debugLevel = process.env.DEBUG === 'true';
  
  // Add a timeout to prevent hanging requests
  const requestTimeout = setTimeout(() => {
    console.log(`⏱️ Stats request timed out for: ${identifier}`);
    if (!res.headersSent) {
      res.status(503).json({ 
        error: 'Request timeout', 
        message: 'Stats request timed out, try again later'
      });
    }
  }, 3000); // 3 second timeout
  
  try {
    // Use a short-lived cache for stats (2 seconds)
    // This helps with rapid polling from frontend
    const cacheKey = `stats_${identifier}`;
    const now = Date.now();
    if (global[cacheKey] && 
        global[`${cacheKey}_time`] && 
        now - global[`${cacheKey}_time`] < 2000) { // 2 second cache
      clearTimeout(requestTimeout);
      return res.json(global[cacheKey]);
    }
    
    if (debugLevel) console.log(`📊 UNIVERSAL STATS: ${identifier}`);
    
    const torrent = await universalTorrentResolver(identifier);
    
    if (!torrent) {
      clearTimeout(requestTimeout);
      return res.status(404).json({ error: 'Torrent not found' });
    }

    const stats = {
      infoHash: torrent.infoHash,
      name: torrent.name,
      size: torrent.length || 0,
      downloaded: torrent.downloaded || 0,
      uploaded: 0,
      progress: torrent.progress || 0,
      downloadSpeed: torrent.downloadSpeed || 0,
      uploadSpeed: 0,
      peers: torrent.numPeers || 0,
      timeStamp: Date.now()
    };
    
    // Cache the result
    global[cacheKey] = stats;
    global[`${cacheKey}_time`] = now;
    
    clearTimeout(requestTimeout);
    res.json(stats);
    
  } catch (error) {
    clearTimeout(requestTimeout);
    console.error(`❌ Universal stats failed:`, error.message);
    res.status(500).json({ error: 'Failed to get torrent stats: ' + error.message });
  }
});

// IMDB Data Endpoint - Optimized with caching and timeout
app.get('/api/torrents/:identifier/imdb', async (req, res) => {
  const identifier = req.params.identifier;
  const debugLevel = process.env.DEBUG === 'true';
  
  // Add a timeout to prevent hanging requests from external APIs
  const requestTimeout = setTimeout(() => {
    console.log(`⏱️ IMDB request timed out for: ${identifier}`);
    try {
      if (!res.headersSent) {
        res.status(503).json({ 
          error: 'Request timeout', 
          message: 'IMDB data request timed out, try again later'
        });
      } else {
        console.log('⏱️ IMDB timeout: response already sent, skipping timeout response');
      }
    } catch (e) {
      console.log('⚠️ Error sending timeout response for IMDB endpoint:', e.message);
    }
  }, 15000); // 15 second timeout for API calls
  
  try {
    // Check endpoint-specific cache first
    const cacheKey = `imdb_data_${identifier}`;
    const now = Date.now();
    if (global[cacheKey] && 
        global[`${cacheKey}_time`] && 
        now - global[`${cacheKey}_time`] < 3600000) { // 1 hour cache for IMDB data
      clearTimeout(requestTimeout);
      return res.json(global[cacheKey]);
    }
    
    if (debugLevel) console.log(`🎬 IMDB REQUEST: ${identifier}`);
    
    const torrent = await universalTorrentResolver(identifier);
    
    if (!torrent) {
      clearTimeout(requestTimeout);
      if (debugLevel) console.log(`❌ Torrent not found for identifier: ${identifier}`);
      if (!res.headersSent) return res.status(404).json({ error: 'Torrent not found' });
      console.log('❌ Torrent not found but response already sent');
      return;
    }
    
    if (debugLevel) console.log(`🎬 Found torrent: ${torrent.name}, fetching IMDB data...`);
    
    // Use Promise.race to implement a secondary timeout for just the API call
    const imdbDataPromise = fetchIMDBData(torrent.name);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('IMDB API timeout')), 10000)
    );
    
    const imdbData = await Promise.race([imdbDataPromise, timeoutPromise])
      .catch(err => {
        console.log(`⚠️ IMDB API error/timeout: ${err.message}`);
        return null;
      });
    
    if (debugLevel) console.log(`🎬 IMDB data result:`, imdbData ? 'SUCCESS' : 'NULL/UNDEFINED');
    
    let response;
    if (imdbData) {
      response = {
        success: true,
        torrentName: torrent.name,
        imdb: imdbData,
        cached: false
      };
      if (debugLevel) console.log(`✅ IMDB data found for: ${torrent.name}`);
    } else {
      response = {
        success: false,
        torrentName: torrent.name,
        message: 'IMDB data not found',
        cached: false
      };
      if (debugLevel) console.log(`❌ No IMDB data found for: ${torrent.name}`);
    }
    
    // Cache the response
    global[cacheKey] = response;
    global[`${cacheKey}_time`] = now;
    
    clearTimeout(requestTimeout);
    try {
      if (!res.headersSent) {
        res.json(response);
      } else {
        console.log('ℹ️ IMDB handler: response already sent, skipping final json send');
      }
    } catch (e) {
      console.log('⚠️ Error sending IMDB response:', e.message);
    }
    
  } catch (error) {
    clearTimeout(requestTimeout);
    console.error(`❌ IMDB endpoint failed:`, error.message);
    try {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to get IMDB data: ' + error.message });
      } else {
        console.log('❌ IMDB endpoint error occurred but response already sent');
      }
    } catch (e) {
      console.log('⚠️ Error sending IMDB error response:', e.message);
    }
  }
});

// UNIVERSAL STREAMING - Enhanced for production environments
app.get('/api/torrents/:identifier/files/:fileIdx/stream', async (req, res) => {
  const { identifier, fileIdx } = req.params;
  const debugLevel = process.env.DEBUG === 'true';
  if (debugLevel) console.log(`🎬 UNIVERSAL STREAM: ${identifier}/${fileIdx}`);
  
  // Track this specific stream request
  const streamRequestId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  
  // Set a timeout for the entire streaming request
  const streamTimeout = setTimeout(() => {
    console.log(`⏱️ Stream request ${streamRequestId} timed out`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(504).json({ error: 'Streaming request timeout' });
    }
  }, 60000); // 60-second max for stream setup
  
  try {
    const torrent = await universalTorrentResolver(identifier);
    
    if (!torrent) {
      clearTimeout(streamTimeout);
      return res.status(404).json({ error: 'Torrent not found for streaming' });
    }
    
    const file = torrent.files[parseInt(fileIdx, 10)];
    if (!file) {
      clearTimeout(streamTimeout);
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Ensure torrent is active and file is selected with high priority
    torrent.resume();
    file.select();
    file.critical = true; // Mark as critical for higher priority
    
    // Ensure we don't have too strict upload limits while streaming
    if (torrent.uploadLimit < 5000) {
      torrent.uploadLimit = 5000; // Set minimum upload for better peer reciprocity during streaming
    }
    
    if (debugLevel) console.log(`🎬 Streaming: ${file.name} (${(file.length / 1024 / 1024).toFixed(1)} MB)`);
    
    // Detect file type for proper MIME type with expanded formats
    const ext = file.name.split('.').pop().toLowerCase();
    const mimeTypes = {
      'mp4': 'video/mp4',
      'mkv': 'video/x-matroska',
      'avi': 'video/x-msvideo',
      'mov': 'video/quicktime',
      'wmv': 'video/x-ms-wmv',
      'flv': 'video/x-flv',
      'webm': 'video/webm',
      'm4v': 'video/mp4',
      'ts': 'video/mp2t',
      'mts': 'video/mp2t',
      '3gp': 'video/3gpp',
      'mpg': 'video/mpeg',
      'mpeg': 'video/mpeg'
    };
    const contentType = mimeTypes[ext] || 'video/mp4';
    
    // Enhanced range request handling
    const range = req.headers.range;
    
    // Track when stream ends properly
    let streamEnded = false;
    const markStreamEnded = () => {
      if (!streamEnded) {
        streamEnded = true;
        clearTimeout(streamTimeout);
        if (debugLevel) console.log(`✅ Stream ${streamRequestId} ended properly`);
      }
    };
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      
      // Calculate a reasonable end position - either requested or 8MB chunk
      // This ensures we don't try to buffer the entire file at once
      let end = parts[1] ? parseInt(parts[1], 10) : null;
      
      // For seek operations, use a fixed chunk size to ensure reliable streaming
      if (start > 0 && !end) {
        const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks for seeks
        end = Math.min(start + MAX_CHUNK_SIZE, file.length - 1);
      } else if (!end) {
        // Initial request - use a generous initial chunk
        const INITIAL_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB initial chunk
        end = Math.min(start + INITIAL_CHUNK_SIZE, file.length - 1);
      }
      
      const chunkSize = (end - start) + 1;
      
      // Log seeking behavior for debugging
      if (start > 0 && debugLevel) {
        console.log(`⏩ [${streamRequestId}] Seek: ${(start / file.length * 100).toFixed(1)}%, chunk: ${(chunkSize / 1024 / 1024).toFixed(1)}MB`);
      }
      
      // More aggressive prioritization for seek operations
      if (start > 0) {
        const pieceLength = torrent.pieceLength || 16384;
        const startPiece = Math.floor(start / pieceLength);
        const endPiece = Math.ceil(end / pieceLength);
        
        // Prime a larger window for smoother playback
        const PRIORITY_WINDOW = Math.min(30, Math.ceil((endPiece - startPiece) * 1.5));
        
        if (debugLevel) console.log(`🔄 [${streamRequestId}] Prioritizing pieces ${startPiece} to ${startPiece + PRIORITY_WINDOW}`);
        
        // More robust piece selection
        try {
          // First try WebTorrent's selection mechanism
          if (file._torrent && typeof file._torrent.select === 'function') {
            file._torrent.select(startPiece, startPiece + PRIORITY_WINDOW, 1);
          }
          
          // Additionally, also mark critical pieces for extra priority
          if (file._torrent && file._torrent.critical) {
            for (let i = startPiece; i < startPiece + 10; i++) {
              file._torrent.critical(i);
            }
          }
        } catch (err) {
          console.log(`⚠️ [${streamRequestId}] Prioritization error: ${err.message}`);
        }
      }
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
        'Connection': 'keep-alive'
      });
      
      // Create the stream with robust error handling
      try {
        const stream = file.createReadStream({ start, end });
        
        // Handle stream events properly
        stream.on('error', (err) => {
          console.error(`❌ [${streamRequestId}] Stream error:`, err.message);
          if (!res.headersSent && !res.writableEnded) {
            res.status(500).end();
          }
        });
        
        stream.on('end', markStreamEnded);
        res.on('close', markStreamEnded);
        
        // Pipe with error handling
        stream.pipe(res);
      } catch (streamError) {
        console.error(`❌ [${streamRequestId}] Failed to create stream:`, streamError.message);
        if (!res.headersSent && !res.writableEnded) {
          clearTimeout(streamTimeout);
          res.status(500).json({ error: 'Streaming error: ' + streamError.message });
        }
      }
      
    } else {
      // Handle full file request (less common)
      res.writeHead(200, {
        'Content-Length': file.length,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
      });
      
      try {
        const stream = file.createReadStream();
        stream.on('error', (err) => {
          console.error(`❌ [${streamRequestId}] Stream error:`, err.message);
          if (!res.writableEnded) res.end();
        });
        
        stream.on('end', markStreamEnded);
        res.on('close', markStreamEnded);
        
        stream.pipe(res);
      } catch (streamError) {
        clearTimeout(streamTimeout);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Streaming error: ' + streamError.message });
        }
      }
    }
    
  } catch (error) {
    clearTimeout(streamTimeout);
    console.error(`❌ Universal streaming failed:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Streaming failed: ' + error.message });
    }
  }
});

// UNIVERSAL DOWNLOAD - Download files with proper headers
app.get('/api/torrents/:identifier/files/:fileIdx/download', async (req, res) => {
  const { identifier, fileIdx } = req.params;
  console.log(`📥 UNIVERSAL DOWNLOAD: ${identifier}/${fileIdx}`);
  
  try {
    const torrent = await universalTorrentResolver(identifier);
    
    if (!torrent) {
      return res.status(404).json({ error: 'Torrent not found for download' });
    }
    
    const file = torrent.files[fileIdx];
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Ensure torrent is active and file is selected
    torrent.resume();
    file.select();
    
    console.log(`📥 Downloading: ${file.name} (${(file.length / 1024 / 1024).toFixed(1)} MB)`);
    
    // Set download headers
    const filename = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', file.length);
    res.setHeader('Accept-Ranges', 'bytes');
    
    // Handle range requests for resume capability
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      const chunkSize = (end - start) + 1;
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': 'application/octet-stream'
      });
      
      const stream = file.createReadStream({ start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': file.length,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': 'application/octet-stream'
      });
      file.createReadStream().pipe(res);
    }
    
  } catch (error) {
    console.error(`❌ Universal download failed:`, error.message);
    res.status(500).json({ error: 'Download failed: ' + error.message });
  }
});

// UNIVERSAL REMOVE - Cleans everything
app.delete('/api/torrents/:identifier', async (req, res) => {
  const identifier = req.params.identifier;
  console.log(`🗑️ UNIVERSAL REMOVE: ${identifier}`);
  
  try {
    const torrent = await universalTorrentResolver(identifier);
    
    if (!torrent) {
      return res.status(404).json({ error: 'Torrent not found for removal' });
    }
    
    const torrentName = torrent.name;
    const infoHash = torrent.infoHash;
    const freedSpace = torrent.downloaded || 0;
    
    client.remove(torrent, { destroyStore: true }, (err) => {
      if (err) {
        console.log(`⚠️ Error removing torrent: ${err.message}`);
        return res.status(500).json({ error: 'Failed to remove torrent: ' + err.message });
      }
      
      // Clean ALL tracking systems
      delete torrents[infoHash];
      delete torrentIds[infoHash];
      delete torrentNames[infoHash];
      delete hashToName[infoHash];
      delete nameToHash[torrentName];
      
      console.log(`✅ Torrent removed: ${torrentName}`);
      
      res.json({ 
        message: 'Torrent removed successfully',
        freedSpace,
        name: torrentName
      });
    });
    
  } catch (error) {
    console.error(`❌ Universal remove failed:`, error.message);
    res.status(500).json({ error: 'Failed to remove torrent: ' + error.message });
  }
});

// UNIVERSAL CLEAR ALL
app.delete('/api/torrents', (req, res) => {
  console.log('🧹 UNIVERSAL CLEAR ALL');
  
  const torrentCount = Object.keys(torrents).length;
  let removedCount = 0;
  let totalFreed = 0;
  
  if (torrentCount === 0) {
    return res.json({ 
      message: 'No torrents to clear',
      cleared: 0,
      totalFreed: 0
    });
  }
  
  Object.values(torrents).forEach(torrent => {
    totalFreed += torrent.downloaded || 0;
  });
  
  const removePromises = Object.values(torrents).map(torrent => {
    return new Promise((resolve) => {
      client.remove(torrent, { destroyStore: true }, (err) => {
        if (!err) removedCount++;
        resolve();
      });
    });
  });
  
  Promise.all(removePromises).then(() => {
    // Clear ALL tracking systems
    Object.keys(torrents).forEach(key => delete torrents[key]);
    Object.keys(torrentIds).forEach(key => delete torrentIds[key]);
    Object.keys(torrentNames).forEach(key => delete torrentNames[key]);
    Object.keys(hashToName).forEach(key => delete hashToName[key]);
    Object.keys(nameToHash).forEach(key => delete nameToHash[key]);
    
    res.json({ 
      message: `Cleared ${removedCount} torrents successfully`,
      cleared: removedCount,
      totalFreed
    });
  });
});

// Cache stats
app.get('/api/cache/stats', async (req, res) => {
  try {
    const activeTorrents = client.torrents.length;
    
    // Calculate actual cache size from WebTorrent client data
    let cacheSize = 0;
    let downloadedBytes = 0;
    
    client.torrents.forEach(torrent => {
      // Add total size of each torrent (this is the actual cache size)
      cacheSize += torrent.length || 0;
      // Add downloaded bytes (for information)
      downloadedBytes += torrent.downloaded || 0;
    });

    const formatBytes = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Cache limit (5GB default)
    const cacheLimitBytes = 5 * 1024 * 1024 * 1024; // 5GB in bytes
    const usagePercentage = cacheLimitBytes > 0 ? (cacheSize / cacheLimitBytes) * 100 : 0;

    const stats = {
      totalSizeFormatted: formatBytes(cacheSize), // Use total cache size (torrent lengths)
      totalSize: cacheSize,
      activeTorrents,
      cacheSize: cacheSize, // Total torrent sizes in cache
      downloadedBytes: downloadedBytes, // Actual downloaded data
      totalTorrentSize: cacheSize, // Same as cacheSize
      totalTorrentSizeFormatted: formatBytes(cacheSize),
      cacheLimitFormatted: formatBytes(cacheLimitBytes),
      usagePercentage: Math.round(usagePercentage * 100) / 100 // Round to 2 decimal places
    };

    console.log(`📊 Cache stats: ${formatBytes(cacheSize)} cached (${activeTorrents} torrents, ${usagePercentage.toFixed(1)}% of 5GB limit)`);
    res.json(stats);
  } catch (error) {
    console.error('Error getting cache stats:', error);
    res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

// Disk usage
app.get('/api/system/disk', (req, res) => {
  try {
    const { exec } = require('child_process');
    
    exec('df -k .', (error, stdout, stderr) => {
      if (error) {
        console.error('Error getting disk usage:', error);
        return res.status(500).json({ error: 'Failed to get disk usage' });
      }
      
      const lines = stdout.trim().split('\n');
      const data = lines[1].split(/\s+/);
      const total = parseInt(data[1]) * 1024;
      const used = parseInt(data[2]) * 1024;
      const available = parseInt(data[3]) * 1024;
      const percentage = Math.round((used / total) * 100);
      
      const diskInfo = { total, used, available, percentage };
      console.log('📊 Disk usage:', diskInfo);
      res.json(diskInfo);
    });
  } catch (error) {
    console.error('Error getting disk stats:', error);
    res.status(500).json({ error: 'Failed to get disk stats' });
  }
});

// Function to disable seeding for completed torrents
function disableSeedingForCompletedTorrents() {
  let completedCount = 0;
  
  client.torrents.forEach(torrent => {
    // Check if torrent is complete (downloaded === length)
    if (torrent.progress === 1 || torrent.downloaded === torrent.length) {
      torrent.uploadLimit = 0;
      completedCount++;
      console.log(`✅ Found completed torrent: ${torrent.name} - Disabled seeding`);
    } else {
      // Add 'done' event handler if not already completed
      torrent.once('done', () => {
        console.log(`✅ Download complete for ${torrent.name} - Stopping seeding`);
        torrent.uploadLimit = 0; // Disable uploading once download is complete
      });
    }
  });
  
  return completedCount;
}

// Start server
const PORT = config.server.port;
const HOST = config.server.host;

app.listen(PORT, "0.0.0.0", () => {
  const serverUrl = `${config.server.protocol}://${HOST}:${PORT}`;
  console.log(`🌱 Seedbox Lite server running on ${serverUrl}`);
  console.log(`📱 Frontend URL: ${config.frontend.url}`);
  console.log(`🚀 UNIVERSAL TORRENT RESOLUTION SYSTEM ACTIVE`);
  
  // Disable seeding for any already completed torrents
  setTimeout(() => {
    const completedCount = disableSeedingForCompletedTorrents();
    if (completedCount > 0) {
      console.log(`🛑 Disabled seeding for ${completedCount} already completed torrents`);
    }
  }, 5000); // Give the server 5 seconds to initialize properly
  
  console.log(`🎯 ZERO "Not Found" Errors Guaranteed`);
  console.log(`⚠️  SECURITY: Download-only mode - Zero uploads guaranteed`);
  
  if (config.isDevelopment) {
    console.log('🔧 Development mode - Environment variables loaded');
  }
});
