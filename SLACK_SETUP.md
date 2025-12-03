# 🤖 Slack Integration Setup Guide

This guide will help you set up Slack integration for SeedBox Lite, allowing you to manage torrents directly from Slack using slash commands or by posting magnet links in channels.

## Features

- **🎬 Torrent Type Classification**: Specify if content is a Movie or TV show
- **📁 Storage Location Management**: Set custom download destinations
- **📍 Location Tracking**: View where torrents are stored
- **🔄 Move Torrents**: Change storage location after adding
- **🎉 Completion Notifications**: Automatic alerts when downloads reach 100%
- **💬 Message Monitoring**: Auto-detect magnet links in messages
- **📊 Rich Progress Tracking**: Real-time download status updates

## Prerequisites

- SeedBox Lite server running
- Slack workspace with admin access
- A Slack app (we'll create this in the steps below)

## Step 1: Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Enter:
   - **App Name**: `SeedBox Lite Bot` (or your preferred name)
   - **Workspace**: Select your workspace
5. Click **"Create App"**

## Step 2: Configure Bot Permissions

1. In your app settings, go to **"OAuth & Permissions"** in the sidebar
2. Scroll down to **"Scopes"** → **"Bot Token Scopes"**
3. Add the following scopes:
   - `chat:write` - Post messages to channels
   - `commands` - Add slash commands
   - `reactions:write` - Add reactions to messages
   - `channels:history` - View messages in public channels
   - `groups:history` - View messages in private channels

4. Scroll up and click **"Install to Workspace"**
5. Authorize the app
6. Copy the **"Bot User OAuth Token"** (starts with `xoxb-`)
   - Save this as `SLACK_BOT_TOKEN` in your environment variables

## Step 3: Get Signing Secret

1. In your app settings, go to **"Basic Information"** in the sidebar
2. Scroll down to **"App Credentials"**
3. Copy the **"Signing Secret"**
   - Save this as `SLACK_SIGNING_SECRET` in your environment variables

## Step 4: Enable Socket Mode (Recommended)

Socket Mode allows your bot to work without exposing a public endpoint.

1. In your app settings, go to **"Socket Mode"** in the sidebar
2. Toggle **"Enable Socket Mode"** to ON
3. Click **"Generate an app-level token"**
   - **Token Name**: `socket-token` (or your preferred name)
   - **Scope**: Add `connections:write`
4. Click **"Generate"**
5. Copy the token (starts with `xapp-`)
   - Save this as `SLACK_APP_TOKEN` in your environment variables

**Note**: If you don't enable Socket Mode, you'll need to set up a public endpoint for Slack to send events to your server.

## Step 5: Create Slash Commands

1. In your app settings, go to **"Slash Commands"** in the sidebar
2. Click **"Create New Command"** for each command below:

### Command 1: /torrent

- **Command**: `/torrent`
- **Request URL**: `http://your-server:3002/slack/events` (only needed if NOT using Socket Mode)
- **Short Description**: `Add a torrent with optional type and destination`
- **Usage Hint**: `<magnet-link> [movie|tv] [destination-path]`
- Click **"Save"**

### Command 2: /torrent-list

- **Command**: `/torrent-list`
- **Request URL**: `http://your-server:3002/slack/events` (only needed if NOT using Socket Mode)
- **Short Description**: `List all active torrents with locations`
- Click **"Save"**

### Command 3: /torrent-location

- **Command**: `/torrent-location`
- **Request URL**: `http://your-server:3002/slack/events` (only needed if NOT using Socket Mode)
- **Short Description**: `Show storage location for a torrent`
- **Usage Hint**: `<hash>`
- Click **"Save"**

### Command 4: /torrent-move

- **Command**: `/torrent-move`
- **Request URL**: `http://your-server:3002/slack/events` (only needed if NOT using Socket Mode)
- **Short Description**: `Move a torrent to a new location`
- **Usage Hint**: `<hash> <new-destination>`
- Click **"Save"**

### Command 5: /torrent-clear-cache

- **Command**: `/torrent-clear-cache`
- **Request URL**: `http://your-server:3002/slack/events` (only needed if NOT using Socket Mode)
- **Short Description**: `Clear completed torrents to free up space`
- **Usage Hint**: `[all]`
- Click **"Save"**

### Command 6: /torrent-search

- **Command**: `/torrent-search`
- **Request URL**: `http://your-server:3002/slack/events` (only needed if NOT using Socket Mode)
- **Short Description**: `Search for torrents across multiple providers`
- **Usage Hint**: `<movie or tv show name>`
- Click **"Save"**

## Step 6: Enable Event Subscriptions

1. In your app settings, go to **"Event Subscriptions"** in the sidebar
2. Toggle **"Enable Events"** to ON
3. Under **"Subscribe to bot events"**, add:
   - `message.channels` - Listen to messages in public channels
   - `message.groups` - Listen to messages in private channels
4. Click **"Save Changes"**

## Step 7: Configure Environment Variables

Add these variables to your server's environment configuration:

### For Production (`.env.production`)

```bash
# Slack Integration
SLACK_BOT_TOKEN=xoxb-your-actual-bot-token
SLACK_SIGNING_SECRET=your-actual-signing-secret
SLACK_APP_TOKEN=xapp-your-actual-app-token
SLACK_PORT=3002
SLACK_AUTO_ADD_TORRENTS=false
```

### For Docker (`.env.docker`)

Same as above - the variables are already added to the template files.

### Environment Variable Descriptions

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token from Step 2 |
| `SLACK_SIGNING_SECRET` | Yes | Signing Secret from Step 3 |
| `SLACK_APP_TOKEN` | Yes (for Socket Mode) | App-level token from Step 4 |
| `SLACK_PORT` | No | Port for Slack events (default: 3002) |
| `SLACK_AUTO_ADD_TORRENTS` | No | Set to `true` to auto-add torrents from messages (default: false) |

## Step 8: Invite Bot to Channels

1. Go to the Slack channel where you want to use the bot
2. Type `/invite @SeedBox Lite Bot` (or your bot's name)
3. The bot will join the channel

## Step 9: Restart Your Server

Restart the SeedBox Lite server to load the new environment variables:

```bash
# For PM2
pm2 restart seedbox-backend

# For Docker
docker-compose restart

# For development
npm run dev
```

You should see a log message:
```
✅ Slack bot is running (Socket Mode)
```

## Usage Examples

### 1. Adding a Basic Torrent

Simple torrent addition without type or destination:

```
/torrent magnet:?xt=urn:btih:1234567890abcdef...
```

The bot will:
1. Acknowledge the command
2. Add the torrent to default location (`/downloads`)
3. Reply with torrent details (name, size, progress, storage location)
4. Send a notification when download reaches 100% 🎉

### 2. Adding a Movie

Add a torrent and classify it as a movie:

```
/torrent magnet:?xt=urn:btih:1234567890abcdef... movie
```

- Type: 🎬 MOVIE
- Default location: `/media/movies`
- Completion notification will be sent when ready

### 3. Adding a TV Show

Add a torrent and classify it as a TV show:

```
/torrent magnet:?xt=urn:btih:1234567890abcdef... tv
```

- Type: 📺 TV
- Default location: `/media/tv`
- Completion notification will be sent when ready

### 4. Custom Storage Location

Specify a custom destination path:

```
/torrent magnet:?xt=urn:btih:1234567890abcdef... movie /media/movies/action
```

Or for TV shows:

```
/torrent magnet:?xt=urn:btih:1234567890abcdef... tv /media/tv/scifi
```

### 5. Listing All Active Torrents

View all torrents with their types, progress, and locations:

```
/torrent-list
```

Response includes:
- 🎬 Movie icon or 📺 TV icon or 📁 General icon
- Name and progress percentage
- Storage location
- Short hash for reference

### 6. Check Torrent Location

Get detailed information about where a specific torrent is stored:

```
/torrent-location 1a2b3c4d
```

Shows:
- Torrent name and type
- Full storage path
- Who added it and when
- Complete hash

### 7. Move a Torrent

Change the destination for a torrent:

**Recommended workflow:**
1. First, check current location: `/torrent-location 1a2b3c4d`
2. Then move it: `/torrent-move 1a2b3c4d /media/movies/comedy`

```
/torrent-move 1a2b3c4d /media/movies/comedy
```

**What happens:**

- **If download is complete (100%)**: Files are moved immediately
  - Response shows: `✅ Files Moved Successfully`
  - Shows how many files were moved: `📦 3/3 files moved successfully`

- **If download is in progress**: Move is scheduled
  - Response shows: `⏳ Move Scheduled`
  - Files will be moved automatically when download reaches 100%
  - You can still watch progress with `/torrent-list`

**Features:**
- Automatically creates destination directory if it doesn't exist
- Moves all files from the torrent (preserving folder structure)
- Shows detailed status of the move operation
- Handles errors gracefully (e.g., if files already exist)

**Important Notes:**
- The move operation works from the **actual** download location (which might be `/tmp/seedbox-downloads`, `/tmp/webtorrent`, etc.)
- Use `/torrent-location` first to verify where files currently are
- The "Type" (movie/tv) and "Destination" are metadata labels - actual files may be elsewhere
- Server logs show detailed source/destination paths for debugging

### 8. Auto-Detection in Messages

If `SLACK_AUTO_ADD_TORRENTS=true`:

Simply paste a magnet link in the channel:

```
Check out this torrent: magnet:?xt=urn:btih:1234567890abcdef...
```

The bot will:
1. Add a ⏳ reaction while processing
2. Add the torrent automatically
3. Replace with ✅ when successful
4. Reply in a thread with details
5. Send completion notification at 100%

If `SLACK_AUTO_ADD_TORRENTS=false`:

The bot will only add a 🧲 reaction to acknowledge the magnet link, but won't add it automatically.

### 9. Completion Notifications

When any torrent reaches 100%, you'll automatically receive a notification with:

```
🎉 Download Complete!

Name: 🎬 Movie Title
Type: MOVIE
Progress: ✅ 100%
Location: /media/movies

🔗 Ready to stream at http://your-server:5174
```

This notification is sent automatically every time a download completes!

### 10. Clear Cache

Free up disk space by removing completed (or all) torrents:

**Clear only completed torrents:**
```
/torrent-clear-cache
```

**Clear ALL torrents (including active downloads):**
```
/torrent-clear-cache all
```

**Response:**
```
✅ Cache Cleared Successfully

Torrents Removed: 5
Space Freed: 12.5 GB
Remaining Torrents: 2
Mode: Completed only

Removed:
1. Movie Title A
2. TV Show B
3. Movie Title C
...and 2 more

💡 Tip: Use /torrent-clear-cache all to remove all torrents (including active ones)
```

**What it does:**
- Removes torrents from the system
- Deletes all downloaded files
- Frees up disk space
- Shows how much space was recovered

### 11. Search for Torrents

Search across multiple torrent providers without leaving Slack:

```
/torrent-search Inception 2010
```

**Step-by-step workflow:**

**1. Search for content:**
```
/torrent-search The Dark Knight
```

**2. Bot shows results:**
```
🔍 Search Results for "The Dark Knight"

Found 10 results. React with the number to get the magnet link!

1. The Dark Knight (2008) [1080p]
📦 Size: 2.1 GB | 🌱 Seeds: 1234 | 👥 Peers: 56
🔗 Provider: 1337x
Reply with `1` to get magnet link

2. The Dark Knight 2008 720p BluRay
📦 Size: 1.4 GB | 🌱 Seeds: 890 | 👥 Peers: 32
🔗 Provider: YTS
Reply with `2` to get magnet link

...
```

**3. Reply with number in thread:**
```
1
```

**4. Bot retrieves magnet link:**
```
🧲 Magnet Link Retrieved

The Dark Knight (2008) [1080p]
📦 Size: 2.1 GB
🌱 Seeds: 1234

Options:
1️⃣ Reply with `add` to add as general torrent
2️⃣ Reply with `add movie` to add as movie
3️⃣ Reply with `add tv` to add as TV show
4️⃣ Reply with `add movie /path` to add with custom location
```

**5. Add the torrent:**
```
add movie
```

**6. Done!**
```
✅ Torrent added: The Dark Knight (2008) [1080p]
📦 Hash: 1a2b3c4d

You'll be notified when it completes!
```

**Features:**
- Searches multiple providers (1337x, YTS, ThePirateBay, etc.)
- Shows seeds, peers, and file size
- Interactive - just reply with numbers
- Supports all add options (movie, tv, custom paths)
- Results expire after 10 minutes for security

**Tips:**
- Include the year for better results: `Inception 2010`
- Be specific: `The Matrix 1999 1080p`
- Check seeds/peers to find healthy torrents

## Troubleshooting

### Bot Not Responding

1. **Check environment variables**: Ensure all required variables are set correctly
2. **Check server logs**: Look for error messages during Slack initialization
3. **Verify bot is in channel**: Use `/invite @BotName` to add it
4. **Check permissions**: Ensure all OAuth scopes are added correctly

### "Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET" Error

The bot is disabled because the required environment variables are not set. This is normal if you don't want to use Slack integration.

### Commands Not Working

1. **Reinstall the app**: Go to OAuth & Permissions and reinstall
2. **Verify Socket Mode**: Ensure it's enabled if you're using `SLACK_APP_TOKEN`
3. **Check slash commands**: Ensure they're created in the app settings

### Auto-Add Not Working

1. **Check environment variable**: Set `SLACK_AUTO_ADD_TORRENTS=true`
2. **Verify event subscriptions**: Ensure `message.channels` and `message.groups` are enabled
3. **Reinstall the app**: Changes to event subscriptions require reinstalling

## Security Considerations

- **Keep tokens secret**: Never commit tokens to version control
- **Use Socket Mode**: Recommended for easier setup and better security
- **Limit channel access**: Only invite the bot to channels where it's needed
- **Monitor usage**: Check server logs for any unusual activity

## Advanced Configuration

### Using HTTP Mode Instead of Socket Mode

If you prefer to use a public endpoint instead of Socket Mode:

1. Skip Step 4 (don't set `SLACK_APP_TOKEN`)
2. Set up a public URL (e.g., using ngrok, nginx, or cloud provider)
3. Configure your server to be accessible at `http://your-domain:3002`
4. In Slack app settings:
   - **Event Subscriptions**: Set Request URL to `http://your-domain:3002/slack/events`
   - **Slash Commands**: Set Request URL for each command to `http://your-domain:3002/slack/events`

### Customizing Notifications

You can modify the notification format in [`server/handlers/slackHandler.js`](server/handlers/slackHandler.js):

- Edit the `blocks` array in the slash command handlers
- Customize reaction emojis
- Add more fields to the notification

## Quick Reference

### All Available Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/torrent` | `<magnet> [movie\|tv] [path]` | Add torrent with optional type and destination |
| `/torrent-list` | - | List all active torrents with locations |
| `/torrent-location` | `<hash>` | Show storage location for a torrent |
| `/torrent-move` | `<hash> <new-path>` | Move torrent to new location |
| `/torrent-clear-cache` | `[all]` | Clear completed torrents (use `all` to clear everything) |
| `/torrent-search` | `<query>` | Search for torrents across multiple providers |

### Default Storage Locations

| Type | Default Path |
|------|--------------|
| Movie | `/media/movies` |
| TV | `/media/tv` |
| General | `/downloads` |

**Note:** Torrents may be downloaded to different locations depending on your server configuration:
- Docker: Usually `/app/downloads`, `/tmp/webtorrent`, or `/tmp/seedbox-downloads`
- Local: Usually `./downloads`, `/tmp/webtorrent`, or `/tmp/seedbox-downloads`
- WebTorrent decides the actual download location based on available space and configuration

**Important:** Always use `/torrent-location <hash>` to see exactly where a specific torrent is stored before trying to move it. The "Type" and "Destination" in metadata are organizational labels - the actual download location may differ.

### Hash Usage

**Where to find the hash:**

When you add a torrent, the response includes a shortened hash at the bottom:
```
🔗 View in app: http://localhost:5174 | Hash: `1a2b3c4d`
```

You can also use `/torrent-list` to see hashes for all torrents.

**Using hashes:**
- The bot displays 8-character short hashes for readability
- You can use the short hash (8 chars): `1a2b3c4d`
- Or the full hash (40 chars): `1a2b3c4d5e6f7g8h...`
- The bot will match any torrent starting with the hash you provide

**Getting the hash from server logs:**
Check your server logs when adding torrents - you'll see:
```
✅ Torrent added with hash: 1a2b3c4d5e6f7g8h9i0j...
```

### Automatic Features

✅ **100% Completion Notifications** - Sent automatically when download finishes
✅ **Progress Monitoring** - Checked every 10 seconds
✅ **Type Icons** - 🎬 Movies, 📺 TV Shows, 📁 General
✅ **Thread Replies** - All responses in threads to keep channels clean

## Additional Resources

- [Slack API Documentation](https://api.slack.com/docs)
- [Slack Bolt SDK Documentation](https://slack.dev/bolt-js/)
- [SeedBox Lite Main Documentation](README.md)

## Need Help?

If you encounter issues:

1. Check the server logs for detailed error messages
2. Review this setup guide to ensure all steps were followed
3. Open an issue on [GitHub](https://github.com/hotheadhacker/seedbox-lite/issues)

---

**Happy torrenting from Slack! 🚀**
