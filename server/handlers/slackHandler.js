const { App } = require('@slack/bolt');
const path = require('path');
const fs = require('fs');
const TorrentSearchApi = require('torrent-search-api');

/**
 * Slack Bot Handler for Torrent Management
 *
 * Supports two modes of operation:
 * 1. Slash Commands: /torrent <magnet-link> [type] [destination]
 * 2. Message Monitoring: Automatically detects magnet links in channel messages
 *
 * Features:
 * - Progress notifications when torrents complete
 * - Torrent type classification (Movie/TV)
 * - Storage location management
 * - Location listing
 */

class SlackHandler {
  constructor(config = {}) {
    this.config = config;
    this.app = null;
    this.client = null;
    this.isEnabled = false;
    this.torrentHandler = null; // Will be set by the main server
    this.trackedTorrents = new Map(); // Track torrents for completion notifications
    this.torrentMetadata = new Map(); // Store torrent metadata (type, location, etc.)

    // Initialize torrent search API
    this.initializeTorrentSearch();
  }

  /**
   * Initialize torrent search providers
   */
  initializeTorrentSearch() {
    try {
      // Enable public providers (no login required)
      TorrentSearchApi.enablePublicProviders();

      // You can also enable specific providers:
      // TorrentSearchApi.enableProvider('1337x');
      // TorrentSearchApi.enableProvider('ThePirateBay');
      // TorrentSearchApi.enableProvider('Yts');

      console.log('🔍 Torrent search providers initialized');
    } catch (error) {
      console.error('Failed to initialize torrent search:', error);
    }
  }

  /**
   * Initialize the Slack bot
   */
  async initialize() {
    try {
      // Check if Slack is configured
      const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN } = process.env;

      if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET) {
        console.log('⚠️  Slack integration disabled: Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET');
        return false;
      }

      // Initialize Slack app
      this.app = new App({
        token: SLACK_BOT_TOKEN,
        signingSecret: SLACK_SIGNING_SECRET,
        socketMode: !!SLACK_APP_TOKEN, // Use Socket Mode if app token is provided
        appToken: SLACK_APP_TOKEN,
        port: process.env.SLACK_PORT || 3002
      });

      this.client = this.app.client;

      // Register event handlers
      this.registerSlashCommands();
      this.registerMessageListeners();

      // Start the Slack app
      if (SLACK_APP_TOKEN) {
        // Socket Mode - no port needed
        await this.app.start();
        console.log('✅ Slack bot is running (Socket Mode)');
      } else {
        // HTTP Mode - requires public endpoint
        await this.app.start(process.env.SLACK_PORT || 3002);
        console.log(`✅ Slack bot is running on port ${process.env.SLACK_PORT || 3002}`);
      }

      this.isEnabled = true;
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Slack bot:', error.message);
      return false;
    }
  }

  /**
   * Register slash command handlers
   */
  registerSlashCommands() {
    // /torrent command - Add a torrent by magnet link with optional type and destination
    // Usage: /torrent <magnet-link> [movie|tv] [destination-path]
    this.app.command('/torrent', async ({ command, ack, say, client }) => {
      await ack();

      try {
        const parts = command.text.trim().split(/\s+/);
        const magnetLink = parts[0];
        const torrentType = parts[1]?.toLowerCase(); // movie, tv, or undefined
        const destination = parts.slice(2).join(' '); // remaining parts as destination path

        // Validate magnet link
        if (!this.isValidMagnetLink(magnetLink)) {
          await say({
            text: '❌ Invalid magnet link.\n\n*Usage:* `/torrent <magnet-link> [movie|tv] [destination]`\n*Example:* `/torrent magnet:?xt=... movie /media/movies`',
            thread_ts: command.thread_ts
          });
          return;
        }

        // Validate torrent type if provided
        if (torrentType && !['movie', 'tv'].includes(torrentType)) {
          await say({
            text: '❌ Invalid type. Use `movie` or `tv`.\n\n*Usage:* `/torrent <magnet-link> [movie|tv] [destination]`',
            thread_ts: command.thread_ts
          });
          return;
        }

        // Extract torrent name from magnet link
        const torrentName = this.extractTorrentName(magnetLink);

        // Send initial response
        const initialMsg = await say({
          text: `⏳ Adding torrent: *${torrentName}*\nProcessing...`,
          thread_ts: command.thread_ts
        });

        // Add torrent using the handler
        if (!this.torrentHandler) {
          throw new Error('Torrent handler not configured');
        }

        const result = await this.torrentHandler(magnetLink, torrentType, destination);

        // Store metadata for tracking
        const metadata = {
          infoHash: result.infoHash,
          channel: command.channel_id,
          threadTs: command.thread_ts || initialMsg.ts,
          messageTs: initialMsg.ts, // Store the message timestamp for reactions
          type: torrentType || 'unknown',
          destination: destination || (torrentType === 'movie' ? '/app/downloads/movies' : torrentType === 'tv' ? '/app/downloads/tv' : '/downloads'),
          name: result.name || torrentName,
          addedBy: command.user_id, // User ID for mentions
          addedByName: command.user_name, // Username for display
          addedAt: new Date().toISOString()
        };

        this.torrentMetadata.set(result.infoHash, metadata);
        this.trackedTorrents.set(result.infoHash, {
          progress: result.progress || 0,
          notified: false,
          metadata
        });

        // Add initial reaction to show torrent is being processed
        try {
          await client.reactions.add({
            channel: command.channel_id,
            timestamp: initialMsg.ts,
            name: 'hourglass_flowing_sand'
          });
        } catch (error) {
          console.error('Failed to add processing reaction:', error);
        }

        // Build location text
        const locationText = destination
          ? `Custom: ${destination}`
          : torrentType === 'movie'
            ? 'Movies (default)'
            : torrentType === 'tv'
              ? 'TV Shows (default)'
              : 'Downloads (default)';

        // Send success response
        await say({
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✅ *Torrent Added Successfully*`
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Name:*\n${result.name || torrentName}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Type:*\n${torrentType ? `${torrentType === 'movie' ? '🎬' : '📺'} ${torrentType.toUpperCase()}` : '📁 General'}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Files:*\n${result.files?.length || 0} files`
                },
                {
                  type: 'mrkdwn',
                  text: `*Progress:*\n${result.progress || 0}%`
                },
                {
                  type: 'mrkdwn',
                  text: `*Storage:*\n${locationText}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Status:*\n${result.status || 'Starting...'}`
                }
              ]
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `🔗 View in app: ${this.config.frontendUrl || 'http://localhost:5174'} | Hash: \`${result.infoHash?.substring(0, 8)}\``
                }
              ]
            }
          ],
          thread_ts: command.thread_ts
        });

      } catch (error) {
        console.error('Error handling /torrent command:', error);

        // Add error reaction to the initial message
        try {
          await client.reactions.add({
            channel: command.channel_id,
            timestamp: initialMsg.ts,
            name: 'x'
          });
        } catch (reactionError) {
          console.error('Failed to add error reaction:', reactionError);
        }

        await say({
          text: `❌ Error adding torrent: ${error.message}`,
          thread_ts: command.thread_ts
        });
      }
    });

    // /torrent-list command - List all active torrents with locations
    this.app.command('/torrent-list', async ({ command, ack, say }) => {
      await ack();

      try {
        if (!this.torrentListHandler) {
          await say({
            text: '⚠️ Torrent list feature not available',
            thread_ts: command.thread_ts
          });
          return;
        }

        const torrents = await this.torrentListHandler();

        if (!torrents || torrents.length === 0) {
          await say({
            text: 'ℹ️ No active torrents',
            thread_ts: command.thread_ts
          });
          return;
        }

        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📋 *Active Torrents* (${torrents.length})`
            }
          },
          {
            type: 'divider'
          }
        ];

        torrents.forEach((torrent, index) => {
          const metadata = this.torrentMetadata.get(torrent.infoHash);
          const typeIcon = metadata?.type === 'movie' ? '🎬' : metadata?.type === 'tv' ? '📺' : '📁';
          const location = metadata?.destination || 'Unknown';

          blocks.push({
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*${index + 1}. ${typeIcon} ${torrent.name || 'Unknown'}*`
              },
              {
                type: 'mrkdwn',
                text: `Progress: ${torrent.progress || 0}%`
              },
              {
                type: 'mrkdwn',
                text: `Location: \`${location}\``
              },
              {
                type: 'mrkdwn',
                text: `Hash: \`${torrent.infoHash?.substring(0, 8)}\``
              }
            ]
          });
        });

        await say({
          blocks,
          thread_ts: command.thread_ts
        });

      } catch (error) {
        console.error('Error handling /torrent-list command:', error);
        await say({
          text: `❌ Error listing torrents: ${error.message}`,
          thread_ts: command.thread_ts
        });
      }
    });

    // /torrent-location command - Show storage location for a specific torrent
    this.app.command('/torrent-location', async ({ command, ack, say }) => {
      await ack();

      try {
        const hash = command.text.trim();

        if (!hash) {
          await say({
            text: '❌ Please provide a torrent hash.\n\n*Usage:* `/torrent-location <hash>`\n*Example:* `/torrent-location 1a2b3c4d`',
            thread_ts: command.thread_ts
          });
          return;
        }

        // Find torrent by partial hash match
        let matchedHash = null;
        for (const [infoHash, metadata] of this.torrentMetadata.entries()) {
          if (infoHash.toLowerCase().startsWith(hash.toLowerCase())) {
            matchedHash = infoHash;
            break;
          }
        }

        if (!matchedHash) {
          await say({
            text: `❌ No torrent found with hash starting with \`${hash}\`\n\nUse \`/torrent-list\` to see all torrents and their hashes.`,
            thread_ts: command.thread_ts
          });
          return;
        }

        const metadata = this.torrentMetadata.get(matchedHash);
        const typeIcon = metadata.type === 'movie' ? '🎬' : metadata.type === 'tv' ? '📺' : '📁';

        await say({
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📍 *Storage Location*`
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Name:*\n${typeIcon} ${metadata.name}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Type:*\n${metadata.type.toUpperCase()}`
                },
                {
                  type: 'mrkdwn',
                  text: `*Location:*\n\`${metadata.destination}\``
                },
                {
                  type: 'mrkdwn',
                  text: `*Hash:*\n\`${matchedHash}\``
                },
                {
                  type: 'mrkdwn',
                  text: `*Added By:*\n<@${metadata.addedBy}>`
                },
                {
                  type: 'mrkdwn',
                  text: `*Added At:*\n${new Date(metadata.addedAt).toLocaleString()}`
                }
              ]
            }
          ],
          thread_ts: command.thread_ts
        });

      } catch (error) {
        console.error('Error handling /torrent-location command:', error);
        await say({
          text: `❌ Error getting location: ${error.message}`,
          thread_ts: command.thread_ts
        });
      }
    });

    // /torrent-move command - Move a torrent to a new location
    this.app.command('/torrent-move', async ({ command, ack, say }) => {
      await ack();

      try {
        const parts = command.text.trim().split(/\s+/);
        const hash = parts[0];
        const newDestination = parts.slice(1).join(' ');

        if (!hash || !newDestination) {
          await say({
            text: '❌ Invalid usage.\n\n*Usage:* `/torrent-move <hash> <new-destination>`\n*Example:* `/torrent-move 1a2b3c4d /media/movies/action`',
            thread_ts: command.thread_ts
          });
          return;
        }

        // Find torrent by partial hash match
        let matchedHash = null;
        for (const [infoHash] of this.torrentMetadata.entries()) {
          if (infoHash.toLowerCase().startsWith(hash.toLowerCase())) {
            matchedHash = infoHash;
            break;
          }
        }

        if (!matchedHash) {
          await say({
            text: `❌ No torrent found with hash starting with \`${hash}\``,
            thread_ts: command.thread_ts
          });
          return;
        }

        const metadata = this.torrentMetadata.get(matchedHash);
        const oldDestination = metadata.destination;

        // Update the destination in metadata
        metadata.destination = newDestination;
        this.torrentMetadata.set(matchedHash, metadata);

        // Call move handler if available and get result
        let moveResult = null;
        if (this.torrentMoveHandler) {
          try {
            moveResult = await this.torrentMoveHandler(matchedHash, newDestination);
          } catch (error) {
            console.error('Move handler error:', error);
          }
        }

        // Build response based on move result
        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: moveResult?.status === 'complete'
                ? `✅ *Files Moved Successfully*`
                : moveResult?.status === 'partial'
                  ? `⚠️ *Files Partially Moved*`
                  : moveResult?.status === 'scheduled'
                    ? `⏳ *Move Scheduled*`
                    : `✅ *Torrent Location Updated*`
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Name:*\n${metadata.name}`
              },
              {
                type: 'mrkdwn',
                text: `*Old Location:*\n\`${oldDestination}\``
              },
              {
                type: 'mrkdwn',
                text: `*New Location:*\n\`${newDestination}\``
              },
              {
                type: 'mrkdwn',
                text: `*Hash:*\n\`${matchedHash.substring(0, 8)}\``
              }
            ]
          }
        ];

        // Add status info
        if (moveResult) {
          if (moveResult.status === 'complete' && moveResult.movedFiles) {
            blocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📦 *${moveResult.movedFiles}/${moveResult.totalFiles}* files moved successfully`
              }
            });
          } else if (moveResult.status === 'partial') {
            blocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📦 *${moveResult.movedFiles}/${moveResult.totalFiles}* files moved\n⚠️ Some files had errors (check server logs)`
              }
            });
          } else if (moveResult.status === 'scheduled') {
            blocks.push({
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `⏳ Download not complete yet. Files will be moved automatically when download finishes.`
                }
              ]
            });
          }
        } else {
          blocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `ℹ️ Location updated in metadata. Files will be moved when download completes.`
              }
            ]
          });
        }

        await say({
          blocks,
          thread_ts: command.thread_ts
        });

      } catch (error) {
        console.error('Error handling /torrent-move command:', error);
        await say({
          text: `❌ Error moving torrent: ${error.message}`,
          thread_ts: command.thread_ts
        });
      }
    });

    // /torrent-clear-cache command - Clear completed torrents and free up space
    this.app.command('/torrent-clear-cache', async ({ command, ack, say }) => {
      await ack();

      try {
        const args = command.text.trim().toLowerCase();
        const clearAll = args === 'all';

        await say({
          text: `🧹 Clearing cache${clearAll ? ' (all torrents)' : ' (completed torrents)'}...`,
          thread_ts: command.thread_ts
        });

        // Call cache clear handler if available
        if (!this.cacheClearHandler) {
          await say({
            text: '⚠️ Cache clear feature not available',
            thread_ts: command.thread_ts
          });
          return;
        }

        const result = await this.cacheClearHandler(clearAll);

        // Build response
        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *Cache Cleared Successfully*`
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Torrents Removed:*\n${result.removed || 0}`
              },
              {
                type: 'mrkdwn',
                text: `*Space Freed:*\n${result.spaceFreed || 'Unknown'}`
              },
              {
                type: 'mrkdwn',
                text: `*Remaining Torrents:*\n${result.remaining || 0}`
              },
              {
                type: 'mrkdwn',
                text: `*Mode:*\n${clearAll ? 'All torrents' : 'Completed only'}`
              }
            ]
          }
        ];

        if (result.removedList && result.removedList.length > 0) {
          const listText = result.removedList.slice(0, 5).map((name, i) => `${i + 1}. ${name}`).join('\n');
          const moreText = result.removedList.length > 5 ? `\n_...and ${result.removedList.length - 5} more_` : '';

          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Removed:*\n${listText}${moreText}`
            }
          });
        }

        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `💡 Tip: Use \`/torrent-clear-cache all\` to remove all torrents (including active ones)`
            }
          ]
        });

        await say({
          blocks,
          thread_ts: command.thread_ts
        });

      } catch (error) {
        console.error('Error handling /torrent-clear-cache command:', error);
        await say({
          text: `❌ Error clearing cache: ${error.message}`,
          thread_ts: command.thread_ts
        });
      }
    });

    // /torrent-search command - Search for torrents
    this.app.command('/torrent-search', async ({ command, ack, say }) => {
      await ack();

      try {
        const query = command.text.trim();

        if (!query) {
          await say({
            text: '❌ Please provide a search query.\n\n*Usage:* `/torrent-search <movie or tv show name>`\n*Example:* `/torrent-search Inception 2010`',
            thread_ts: command.thread_ts
          });
          return;
        }

        await say({
          text: `🔍 Searching for: *${query}*\nPlease wait...`,
          thread_ts: command.thread_ts
        });

        // Search torrents
        const results = await TorrentSearchApi.search(query, 'All', 10); // Search all providers, limit to 10 results

        if (!results || results.length === 0) {
          await say({
            text: `❌ No torrents found for: *${query}*\n\nTry:\n- Using different keywords\n- Adding the year (e.g., "Inception 2010")\n- Being more specific`,
            thread_ts: command.thread_ts
          });
          return;
        }

        // Build response with search results
        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔍 *Search Results for "${query}"*\n\nFound ${results.length} results. React with the number to get the magnet link!`
            }
          },
          {
            type: 'divider'
          }
        ];

        // Add each result
        results.forEach((result, index) => {
          const size = result.size || 'Unknown';
          const seeds = result.seeds || '?';
          const peers = result.peers || '?';
          const provider = result.provider || 'Unknown';

          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${index + 1}. ${result.title}*\n` +
                    `📦 Size: ${size} | 🌱 Seeds: ${seeds} | 👥 Peers: ${peers}\n` +
                    `🔗 Provider: ${provider}\n` +
                    `_Reply with \`${index + 1}\` to get magnet link_`
            }
          });
        });

        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `💡 Tip: Reply with the number (1-${results.length}) in a thread to get the magnet link and add the torrent`
            }
          ]
        });

        const response = await say({
          blocks,
          thread_ts: command.thread_ts
        });

        // Store search results for this message
        this.searchResults = this.searchResults || new Map();
        this.searchResults.set(response.ts, {
          results,
          query,
          channel: command.channel_id,
          userId: command.user_id
        });

        // Clean up old search results after 10 minutes
        setTimeout(() => {
          this.searchResults.delete(response.ts);
        }, 10 * 60 * 1000);

      } catch (error) {
        console.error('Error handling /torrent-search command:', error);
        await say({
          text: `❌ Error searching torrents: ${error.message}\n\nThis might be due to:\n- Search providers being unavailable\n- Network issues\n- Rate limiting`,
          thread_ts: command.thread_ts
        });
      }
    });
  }

  /**
   * Register message event listeners
   */
  registerMessageListeners() {
    // Listen for number replies to search results (to get magnet links)
    this.app.message(/^[1-9][0-9]?$/, async ({ message, say, client }) => {
      try {
        // Skip bot messages
        if (message.bot_id) return;

        // Check if this is a reply to a search result
        if (!message.thread_ts) return;

        this.searchResults = this.searchResults || new Map();
        const searchData = this.searchResults.get(message.thread_ts);

        if (!searchData) return; // Not a reply to our search

        const selectedIndex = parseInt(message.text.trim()) - 1;

        if (selectedIndex < 0 || selectedIndex >= searchData.results.length) {
          await say({
            text: `❌ Invalid selection. Please choose a number between 1 and ${searchData.results.length}`,
            thread_ts: message.thread_ts
          });
          return;
        }

        const selectedTorrent = searchData.results[selectedIndex];

        // Get magnet link
        await say({
          text: `⏳ Getting magnet link for: *${selectedTorrent.title}*...`,
          thread_ts: message.thread_ts
        });

        const magnetLink = await TorrentSearchApi.getMagnet(selectedTorrent);

        if (!magnetLink) {
          await say({
            text: `❌ Failed to get magnet link for: ${selectedTorrent.title}\n\nThis torrent might not be available anymore.`,
            thread_ts: message.thread_ts
          });
          return;
        }

        // Send magnet link and ask for confirmation
        await say({
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `🧲 *Magnet Link Retrieved*\n\n*${selectedTorrent.title}*\n📦 Size: ${selectedTorrent.size || 'Unknown'}\n🌱 Seeds: ${selectedTorrent.seeds || '?'}`
              }
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Options:*\n1️⃣ Reply with \`add\` to add as general torrent\n2️⃣ Reply with \`add movie\` to add as movie\n3️⃣ Reply with \`add tv\` to add as TV show\n4️⃣ Reply with \`add movie /path\` to add with custom location`
              }
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `Magnet: \`${magnetLink.substring(0, 60)}...\``
                }
              ]
            }
          ],
          thread_ts: message.thread_ts
        });

        // Store magnet link for quick adding
        this.searchResults.set(message.ts, {
          magnetLink,
          torrentTitle: selectedTorrent.title,
          channel: message.channel,
          userId: message.user
        });

        // Clean up after 5 minutes
        setTimeout(() => {
          this.searchResults.delete(message.ts);
        }, 5 * 60 * 1000);

      } catch (error) {
        console.error('Error handling search selection:', error);
      }
    });

    // Listen for "add" command in search result threads
    this.app.message(/^add(\s+(movie|tv|general))?(\s+.*)?$/i, async ({ message, say, client }) => {
      try {
        // Skip bot messages
        if (message.bot_id) return;

        // Must be in a thread
        if (!message.thread_ts) return;

        this.searchResults = this.searchResults || new Map();

        // Find the magnet link data
        let magnetData = null;
        for (const [ts, data] of this.searchResults.entries()) {
          if (data.magnetLink && data.channel === message.channel) {
            magnetData = data;
            break;
          }
        }

        if (!magnetData) return; // Not related to search

        const match = message.text.match(/^add(\s+(movie|tv|general))?(\s+(.+))?$/i);
        const type = match[2]?.toLowerCase();
        const destination = match[4]?.trim();

        await say({
          text: `⏳ Adding torrent: *${magnetData.torrentTitle}*${type ? `\nType: ${type}` : ''}${destination ? `\nDestination: ${destination}` : ''}`,
          thread_ts: message.thread_ts
        });

        if (!this.torrentHandler) {
          await say({
            text: '❌ Torrent handler not configured',
            thread_ts: message.thread_ts
          });
          return;
        }

        const result = await this.torrentHandler(magnetData.magnetLink, type, destination);

        await say({
          text: `✅ Torrent added: *${result.name || magnetData.torrentTitle}*\n📦 Hash: \`${result.infoHash?.substring(0, 8)}\`\n\nYou'll be notified when it completes!`,
          thread_ts: message.thread_ts
        });

      } catch (error) {
        console.error('Error adding torrent from search:', error);
      }
    });

    // Listen for messages containing magnet links
    this.app.message(/magnet:\?xt=/, async ({ message, say, client }) => {
      try {
        // Skip bot messages to avoid loops
        if (message.bot_id) {
          return;
        }

        // Extract magnet link from message
        const magnetLink = this.extractMagnetLink(message.text);

        if (!magnetLink) {
          return;
        }

        // Check if auto-add is enabled
        const autoAdd = process.env.SLACK_AUTO_ADD_TORRENTS === 'true';

        if (!autoAdd) {
          // Just acknowledge the magnet link
          await client.reactions.add({
            channel: message.channel,
            timestamp: message.ts,
            name: 'mag' // magnet emoji
          });
          return;
        }

        // Add a "processing" reaction
        await client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'hourglass_flowing_sand'
        });

        const torrentName = this.extractTorrentName(magnetLink);

        // Add torrent using the handler
        if (!this.torrentHandler) {
          throw new Error('Torrent handler not configured');
        }

        const result = await this.torrentHandler(magnetLink);

        // Remove processing reaction and add success
        await client.reactions.remove({
          channel: message.channel,
          timestamp: message.ts,
          name: 'hourglass_flowing_sand'
        });

        await client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'white_check_mark'
        });

        // Reply in thread
        await say({
          text: `✅ Added torrent: *${result.name || torrentName}*`,
          thread_ts: message.ts
        });

      } catch (error) {
        console.error('Error handling magnet link in message:', error);

        // Add error reaction
        try {
          await client.reactions.add({
            channel: message.channel,
            timestamp: message.ts,
            name: 'x'
          });

          await say({
            text: `❌ Failed to add torrent: ${error.message}`,
            thread_ts: message.ts
          });
        } catch (reactionError) {
          console.error('Failed to add error reaction:', reactionError);
        }
      }
    });
  }

  /**
   * Set the torrent handler function
   */
  setTorrentHandler(handler) {
    this.torrentHandler = handler;
  }

  /**
   * Set the torrent list handler function
   */
  setTorrentListHandler(handler) {
    this.torrentListHandler = handler;
  }

  /**
   * Set the torrent move handler function
   */
  setTorrentMoveHandler(handler) {
    this.torrentMoveHandler = handler;
  }

  /**
   * Set the cache clear handler function
   */
  setCacheClearHandler(handler) {
    this.cacheClearHandler = handler;
  }

  /**
   * Update progress for a torrent and send notification if completed
   */
  async updateTorrentProgress(infoHash, progress) {
    if (!this.isEnabled) return;

    const tracked = this.trackedTorrents.get(infoHash);
    if (!tracked) return;

    const oldProgress = tracked.progress;
    tracked.progress = progress;

    // Check if torrent just completed (reached 100%)
    if (progress >= 100 && oldProgress < 100 && !tracked.notified) {
      tracked.notified = true;
      await this.sendCompletionNotification(infoHash);
    }

    this.trackedTorrents.set(infoHash, tracked);
  }

  /**
   * Send a completion notification to Slack
   */
  async sendCompletionNotification(infoHash) {
    if (!this.isEnabled || !this.client) return;

    try {
      const tracked = this.trackedTorrents.get(infoHash);
      if (!tracked) return;

      const { metadata } = tracked;
      const typeIcon = metadata.type === 'movie' ? '🎬' : metadata.type === 'tv' ? '📺' : '📁';

      // Update reactions: remove hourglass, add checkmark
      try {
        // Remove processing reaction
        await this.client.reactions.remove({
          channel: metadata.channel,
          timestamp: metadata.messageTs,
          name: 'hourglass_flowing_sand'
        });
      } catch (error) {
        // Ignore if reaction doesn't exist
      }

      try {
        // Add completion reaction
        await this.client.reactions.add({
          channel: metadata.channel,
          timestamp: metadata.messageTs,
          name: 'white_check_mark'
        });
      } catch (error) {
        console.error('Failed to add completion reaction:', error);
      }

      // Add a fun emoji based on type
      try {
        const typeEmoji = metadata.type === 'movie' ? 'clapper' : metadata.type === 'tv' ? 'tv' : 'package';
        await this.client.reactions.add({
          channel: metadata.channel,
          timestamp: metadata.messageTs,
          name: typeEmoji
        });
      } catch (error) {
        console.error('Failed to add type reaction:', error);
      }

      // Send completion message
      await this.client.chat.postMessage({
        channel: metadata.channel,
        thread_ts: metadata.threadTs,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🎉 *Download Complete!*\n\n<@${metadata.addedBy}> Your torrent is ready!`
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Name:*\n${typeIcon} ${metadata.name}`
              },
              {
                type: 'mrkdwn',
                text: `*Type:*\n${metadata.type.toUpperCase()}`
              },
              {
                type: 'mrkdwn',
                text: `*Progress:*\n✅ 100%`
              },
              {
                type: 'mrkdwn',
                text: `*Location:*\n\`${metadata.destination}\``
              },
              {
                type: 'mrkdwn',
                text: `*Requested By:*\n<@${metadata.addedBy}>`
              },
              {
                type: 'mrkdwn',
                text: `*Added:*\n${new Date(metadata.addedAt).toLocaleString()}`
              }
            ]
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `🔗 Ready to stream at ${this.config.frontendUrl || 'http://localhost:5174'}`
              }
            ]
          }
        ]
      });

      console.log(`✅ Sent completion notification for: ${metadata.name}`);
    } catch (error) {
      console.error('Error sending completion notification:', error);
    }
  }

  /**
   * Start monitoring torrent progress
   * This should be called periodically by the main server
   */
  async monitorProgress(torrents) {
    if (!this.isEnabled) return;

    for (const torrent of torrents) {
      const progress = Math.round((torrent.progress || 0) * 100);
      await this.updateTorrentProgress(torrent.infoHash, progress);
    }
  }

  /**
   * Validate magnet link format
   */
  isValidMagnetLink(link) {
    if (!link || typeof link !== 'string') {
      return false;
    }

    // Basic magnet link validation
    return link.trim().startsWith('magnet:?') && link.includes('xt=urn:btih:');
  }

  /**
   * Extract magnet link from text
   */
  extractMagnetLink(text) {
    const magnetRegex = /(magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"\s]*)/i;
    const match = text.match(magnetRegex);
    return match ? match[1] : null;
  }

  /**
   * Extract torrent name from magnet link
   */
  extractTorrentName(magnetLink) {
    try {
      const nameMatch = magnetLink.match(/&dn=([^&]+)/);
      if (nameMatch) {
        return decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
      }

      // Fallback to hash
      const hashMatch = magnetLink.match(/btih:([a-zA-Z0-9]+)/i);
      return hashMatch ? `Torrent ${hashMatch[1].substring(0, 8)}` : 'Unknown Torrent';
    } catch (error) {
      return 'Unknown Torrent';
    }
  }

  /**
   * Send a notification to a Slack channel
   */
  async sendNotification(channel, message) {
    if (!this.isEnabled || !this.client) {
      return false;
    }

    try {
      await this.client.chat.postMessage({
        channel,
        text: message
      });
      return true;
    } catch (error) {
      console.error('Error sending Slack notification:', error);
      return false;
    }
  }

  /**
   * Stop the Slack bot
   */
  async stop() {
    if (this.app) {
      await this.app.stop();
      console.log('🛑 Slack bot stopped');
    }
  }
}

module.exports = SlackHandler;
