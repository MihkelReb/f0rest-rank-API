const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.db');

// Define tokenStore at the top
let tokenStore = {
  accessToken: null,
  refreshToken: null,
  tokenExpiry: null
};

// Initialize database with a table for tokens if it doesn't exist yet
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY, accessToken TEXT, refreshToken TEXT, tokenExpiry INTEGER)");
});


async function saveTokensToDB(accessToken, refreshToken, expiry) {
  return new Promise((resolve, reject) => {
    // Use INSERT OR REPLACE based on a constant ID = 1
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
              client_id: process.env.CLIENT_ID,
              client_secret: process.env.CLIENT_SECRET,
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
    const tokenData = await getTokensFromDB();

    if (!tokenData) {
      throw new Error("No tokens found in database.");
    }

    // Check if token is close to expiry and refresh if needed
    if (Date.now() > tokenData.tokenExpiry - 5 * 60 * 1000) { // refresh 5 minutes before expiry
      await refreshAccessToken();
      const refreshedTokenData = await getTokensFromDB();

      if (!refreshedTokenData) {
        throw new Error("Failed to retrieve refreshed tokens from database.");
      }

      return refreshedTokenData.accessToken;
    }

    return tokenData.accessToken;
  } catch (error) {
    console.error("Error in getAccessToken:", error.message);
    throw error; // You can propagate the error up if you want the calling function to handle it, or handle it here.
  }
}



app.get('/auth/callback', async (req, res) => {
  const authorizationCode = req.query.code;

  if (!authorizationCode) {
      return res.status(400).send('No authorization code provided');
  }

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            code: authorizationCode,
            grant_type: 'authorization_code',
            redirect_uri: 'https://f0rest-rank-api.glitch.me/auth/callback'  // This should match exactly what you've registered with Twitch.
        }
    });

    const accessToken = response.data.access_token;
    const refreshToken = response.data.refresh_token;  // If you requested one.

    // Now you can store these tokens securely and use the access token in your API calls.
    
    res.send('Tokens received and stored.');
} catch (error) {
    console.error('Error fetching tokens:', error);
    res.status(500).send('Error fetching tokens from Twitch.');
}
});


const CLIENT_ID = process.env.CLIENT_ID || 'Fallback_ID'; // Provide a fallback or default value
const OAUTH_TOKEN = process.env.OAUTH_TOKEN || 'Fallback_Token'; 
const headers = {
    'Client-ID': CLIENT_ID,
    'Authorization': `Bearer ${OAUTH_TOKEN}`
};

async function isStreamerLive(streamerName) {
  const accessToken = await getAccessToken();
  const headers = {
      'Client-ID': process.env.CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
  };

  const twitchResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${streamerName}`, { headers });
  return twitchResponse.data.data && twitchResponse.data.data.length > 0;
}


// This should be an object, not a boolean
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
