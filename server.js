require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');


let tokenStore = {
  accessToken: null,
  refreshToken: null,
  tokenExpiry: null
};

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY, accessToken TEXT, refreshToken TEXT, tokenExpiry INTEGER)");
});


const CLIENT_ID = process.env.CLIENT_ID || 'Fallback_ID';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'Fallback_Secret';

async function saveTokensToDB(accessToken, refreshToken, expiry) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare("INSERT OR REPLACE INTO tokens (id, accessToken, refreshToken, tokenExpiry) VALUES (1, ?, ?, ?)");
    stmt.run([accessToken, refreshToken, expiry], function(err) {
      if (err) return reject(err);
      resolve(this.lastID);
    });
    stmt.finalize();
  });
}

async function getTokensFromDB() {
  return new Promise((resolve, reject) => {
    db.get("SELECT accessToken, refreshToken, tokenExpiry FROM tokens WHERE id = 1", [], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function refreshAccessToken() {
  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokenStore.refreshToken
      }
    });

    const { access_token, refresh_token, expires_in } = response.data;
    const expiry = Date.now() + (expires_in * 1000);
    tokenStore = { accessToken: access_token, refreshToken: refresh_token, tokenExpiry: expiry };
    await saveTokensToDB(access_token, refresh_token, expiry);
  } catch (error) {
    console.error('Error refreshing token:', error);
  }
}

async function getAccessToken() {
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
  params: {
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    grant_type: 'client_credentials'
  }
});
      
        const response = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials&scope=`);
        const { access_token, expires_in } = response.data;
        const expiry = Date.now() + (expires_in * 1000);
        tokenStore = { accessToken: access_token, tokenExpiry: expiry };
        await saveTokensToDB(access_token, null, expiry);
        return access_token;
    } catch (error) {
        console.error('Error getting access token:', error.response.data);
        return null;
    }
}

// Usage
async () => {
    const token = await getAccessToken();
    console.log('Access token:', token);
};

app.get('/auth/callback', async (req, res) => {
  const authorizationCode = req.query.code;

  if (!authorizationCode) {
    return res.status(400).send('No authorization code provided');
  }

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: authorizationCode,
        grant_type: 'authorization_code',
        redirect_uri: 'https://f0rest-rank-api.glitch.me/auth/callback'
      }
    });

    const { access_token, refresh_token, expires_in } = response.data;
    const expiry = Date.now() + (expires_in * 1000);
    tokenStore = { accessToken: access_token, refreshToken: refresh_token, tokenExpiry: expiry };
    await saveTokensToDB(access_token, refresh_token, expiry);
    
    res.send('Tokens received and stored.');
  } catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).send('Error fetching tokens from Twitch.');
  }
});

// Load environment variables from .env file
require('dotenv').config();

// Access environment variables
const OAUTH_TOKEN = process.env.OAUTH_TOKEN || 'Fallback_Token';


async function isStreamerLive(streamerName) {
  try {
    let accessToken = tokenStore.accessToken || await getAccessToken();

    if (!accessToken) {
      throw new Error("Access token is not available.");
    }

    const headers = {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
    };

    const twitchResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${streamerName}`, { headers });

    if (twitchResponse.status === 401) {
      await refreshAccessToken();
      accessToken = await getAccessToken();
      headers.Authorization = `Bearer ${accessToken}`;

      const retryResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${streamerName}`, { headers });
      if (!retryResponse.data.data) return false;
      return retryResponse.data.data.length > 0;
    }

    if (!twitchResponse.data.data) return false;
    return twitchResponse.data.data.length > 0;
  } catch (error) {
    console.error('Error checking if streamer is live:', error);
    return false;
  }
}

let currentlyChecking = {
  'olofmeister': true,
  'f0rest': true
};

async function checkStreamers() {
  const streamers = ['olofmeister', 'f0rest'];

  for (const streamer of streamers) {
    if (!currentlyChecking[streamer]) continue;

    const live = await isStreamerLive(streamer);
    if (live) {
      await axios.get(`https://f0rest-rank-api.glitch.me/getRank/${streamer}`);
    } else {
      currentlyChecking[streamer] = false;
    }
  }

  const shouldContinueChecking = Object.values(currentlyChecking).some(value => value);
  if (shouldContinueChecking) {
    setTimeout(checkStreamers, 4 * 60 * 1000);
  }
}

checkStreamers();  // Start the check when the server starts

app.get('/getRank/:playerName', async (req, res) => {
  try {
      const playerName = req.params.playerName;
      currentlyChecking[playerName] = true;
      checkStreamers();

    // Make a GET request to the Steam API using playerName
    const steamResponse = await axios.get('https://api.steampowered.com/ICSGOServers_730/GetLeaderboardEntries/v1', {
      params: {
        format: 'json',
        lbname: 'official_leaderboard_premier_season1',
      },
    });

    // Check if the response status code indicates success
    if (steamResponse.status !== 200) {
      return res.status(500).send('Failed to fetch data from the Steam API');
    }

    // Parse the response data as JSON
    const responseData = steamResponse.data;

    // Ensure the response contains the expected structure
    if (!responseData || !responseData.result || !responseData.result.entries) {
      console.error('Invalid response from the Steam API:', responseData);
      return res.status(500).send('Invalid response from the Steam API');
    }

    // Extract the rank for the provided player name
    const leaderboardEntries = responseData.result.entries;

    // Find the player with the provided name
    let rank = null;
    for (const entry of leaderboardEntries) {
      if (entry.name === playerName) {
        rank = entry.rank;
        break;
      }
    }

    if (rank === null) {
      return res.status(404).send(`Player "${playerName}" not found in the leaderboard`);
    }

    // Send the rank as plain text with the desired format
    res.send(`${rank}`);
  } catch (error) {
    console.error('Error fetching rank:', error);
    res.status(500).send('An error occurred while fetching data from the Steam API');
}
});


console.log(axios.defaults);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});