// Import necessary libraries and modules
// Load environment variables from a .env file into process.env
require('dotenv').config();

// Importing the Express.js library for building web server applications
const express = require('express');

// Importing the Axios library for making HTTP requests
const axios = require('axios');

// Importing the sqlite3 library with verbose mode (for more detailed stack traces on errors)
const sqlite3 = require('sqlite3').verbose();

// Creating an Express application instance
const app = express();

// Setting the server port, defaulting to 3000 if the PORT environment variable isn't set
const port = process.env.PORT || 3000;

// Creating a new SQLite database connection to the 'database.db' file
const db = new sqlite3.Database('./database.db');

// Initializing a store to keep track of authentication tokens and their expiry time
let tokenStore = {
  accessToken: null,   // Store for the access token
  refreshToken: null,  // Store for the refresh token (if applicable)
  tokenExpiry: null    // Timestamp for when the access token expires
};

// Serializing database operations ensures they run in sequence 
db.serialize(() => {
  // Execute the SQL command to create a 'tokens' table in the database
  // This table will only be created if it doesn't already exist
  // It consists of an ID (integer & primary key), accessToken, refreshToken (both text), and tokenExpiry (integer for timestamp)
  db.run("CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY, accessToken TEXT, refreshToken TEXT, tokenExpiry INTEGER)");
});

// Retrieve the CLIENT_ID from the environment variables. If it doesn't exist, use 'Fallback_ID' as a default value.
const CLIENT_ID = process.env.CLIENT_ID || 'Fallback_ID';

// Retrieve the CLIENT_SECRET from the environment variables. If it doesn't exist, use 'Fallback_Secret' as a default value.
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'Fallback_Secret';

// Retrieve the OAUTH_TOKEN from the environment variables. If it doesn't exist, use 'Fallback_Token' as a default value.
const OAUTH_TOKEN = process.env.OAUTH_TOKEN || 'Fallback_Token';


/**
 * Function to save tokens to the database
 * Asynchronously save access and refresh tokens into the database.
 * 
 * @param {string} accessToken - The access token to be saved.
 * @param {string|null} refreshToken - The refresh token to be saved. Can be null for client credentials grant.
 * @param {number} expiry - The timestamp at which the access token will expire.
 * @returns {Promise<number>} Resolves with the last inserted ID if successful, otherwise rejects with an error.
 */
async function saveTokensToDB(accessToken, refreshToken, expiry) {
  return new Promise((resolve, reject) => {
    // Prepare an SQL statement to insert or replace tokens in the database. 
    // The use of "INSERT OR REPLACE" ensures that if an entry with the same ID exists, it will be updated; otherwise, a new entry will be created.
    const stmt = db.prepare("INSERT OR REPLACE INTO tokens (id, accessToken, refreshToken, tokenExpiry) VALUES (1, ?, ?, ?)");

    // Execute the prepared statement with the provided token values.
    stmt.run([accessToken, refreshToken, expiry], function(err) {
      // If there's an error during execution, reject the promise.
      if (err) return reject(err);

      // If successful, resolve the promise with the last inserted ID.
      resolve(this.lastID);
    });

    // Finalize the statement to ensure that no further executions can be made using this statement.
    stmt.finalize();
  });
}


/**
 * Function to retrieve tokens from the database
 * Asynchronously retrieve access and refresh tokens from the database.
 * 
 * @returns {Promise<Object|null>} Resolves with an object containing accessToken, refreshToken, and tokenExpiry if successful.
 * If no tokens are found, resolves with null. Rejects with an error if a database error occurs.
 */
async function getTokensFromDB() {
  return new Promise((resolve, reject) => {
    // Execute an SQL statement to retrieve tokens with the specific ID (1 in this case) from the database.
    db.get("SELECT accessToken, refreshToken, tokenExpiry FROM tokens WHERE id = 1", [], (err, row) => {
      // If there's an error during execution, reject the promise.
      if (err) return reject(err);

      // If successful, resolve the promise with the retrieved row.
      resolve(row);
    });
  });
}


/**
 * Asynchronously request a refreshed access token from Twitch using the stored refresh token.
 * If successful, updates the in-memory token store and saves the new tokens to the database.
 */
async function refreshAccessToken() {
  console.log("Attempting to refresh token...");
  try {
    // Make a POST request to the Twitch token endpoint to refresh the access token
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokenStore.refreshToken // Use the refresh token from the in-memory store
      }
    });

    // Destructure the response to get the new tokens and expiry time
    const { access_token, refresh_token, expires_in } = response.data;

    // Calculate the exact expiry timestamp in milliseconds
    const expiry = Date.now() + (expires_in * 1000);

    // Update the in-memory token store with the new values
    tokenStore = { accessToken: access_token, refreshToken: refresh_token, tokenExpiry: expiry };

    // Save the new tokens to the database
    await saveTokensToDB(access_token, refresh_token, expiry);

  } catch (error) {
    // Log any errors that might occur during the token refresh process
    console.error('Error refreshing token:', error.response ? error.response.data : error);
  } finally {
    console.log("Token refreshed. New expiry:", tokenStore.tokenExpiry);
  }
}


/**
 * Fetches an access token from the Twitch API using client credentials flow.
 * The fetched token is then stored in memory and in the database.
 * 
 * @returns {String|null} - Returns the acquired access token if successful, or null if an error occurred.
 */
async function getAccessToken() {
    try {
        // Make a POST request to the Twitch API to obtain an access token.
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: process.env.CLIENT_ID, // Your Twitch client ID.
                client_secret: process.env.CLIENT_SECRET, // Your Twitch client secret.
                grant_type: 'client_credentials' // Use client credentials OAuth 2.0 flow.
            }
        });

        // Extract the received access token and its duration of validity from the response.
        const { access_token, expires_in } = response.data;

        // Calculate the actual expiration timestamp by adding the current time to the duration of validity.
        const expiry = Date.now() + (expires_in * 1000);

        // Store the newly received access token and its expiration time in memory.
        tokenStore = { accessToken: access_token, tokenExpiry: expiry };

        // Persistently store the new access token and its expiration time in the database. 
        // Note: Since client credentials flow doesn't provide a refresh token, we pass 'null' for the refresh token parameter.
        await saveTokensToDB(access_token, null, expiry);

        // Return the acquired access token to the caller.
        return access_token;
        
    } catch (error) {
        // If an error occurs during the token request process, log it.
        console.error('Error getting access token:', error.response.data);

        // Indicate failure by returning null.
        return null;
    }
}


/**
 * The endpoint handles the callback after the user has authorized the application on Twitch.
 * It takes the authorization code received and exchanges it for an access and refresh token.
 */
app.get('/auth/callback', async (req, res) => {
  // Extract the authorization code from the query parameters.
  const authorizationCode = req.query.code;

  // Check if the authorization code is present in the request.
  if (!authorizationCode) {
    // If not provided, respond with a 400 Bad Request status.
    return res.status(400).send('No authorization code provided');
  }

  try {
    // Use the received authorization code to fetch the access and refresh tokens from Twitch.
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: CLIENT_ID, // Your Twitch client ID.
        client_secret: CLIENT_SECRET, // Your Twitch client secret.
        code: authorizationCode, // The authorization code received from the request.
        grant_type: 'authorization_code', // Specifies the OAuth 2.0 flow being used.
        redirect_uri: 'https://f0rest-rank-api.glitch.me/auth/callback' // The URI where Twitch will redirect the user after authentication.
      }
    });

    // Destructure the access token, refresh token, and its expiry time from the response.
    const { access_token, refresh_token, expires_in } = response.data;

    // Calculate the actual expiration timestamp in milliseconds.
    const expiry = Date.now() + (expires_in * 1000);

    // Update the in-memory token store with the newly received tokens and expiry time.
    tokenStore = { accessToken: access_token, refreshToken: refresh_token, tokenExpiry: expiry };

    // Persistently save the new tokens and their expiration time in the database.
    await saveTokensToDB(access_token, refresh_token, expiry);
    
    // Respond to the client indicating the tokens have been received and stored.
    res.send('Tokens received and stored.');
  } catch (error) {
    // If an error occurs during the token exchange process, log it and respond with a 500 Internal Server Error status.
    console.error('Error fetching tokens:', error);
    res.status(500).send('Error fetching tokens from Twitch.');
  }
});


// Load environment variables from .env file
require('dotenv').config();


/**
 * Function to check if a streamer is currently live on Twitch
 * Asynchronously checks if a Twitch streamer is currently live.
 * @param {string} streamerName - The name of the Twitch streamer to check.
 * @return {boolean} - Returns true if the streamer is live, false otherwise.
 */
async function isStreamerLive(streamerName) {
  try {
    // Try to get the access token from the token store or fetch a new one.
    let accessToken = tokenStore.accessToken || await getAccessToken();

    // If there's no access token, throw an error.
    if (!accessToken) {
      throw new Error("Access token is not available.");
    }

    console.log(`Checking if ${streamerName} is live with access token:`, accessToken);

    // Prepare the headers for the Twitch API request.
    const headers = {
      'Client-ID': CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
    };

    // Make a GET request to the Twitch Helix API to retrieve the stream information for the given streamer name.
    const twitchResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${streamerName}`, { headers });

    console.log(`Received Twitch API response for ${streamerName}:`, twitchResponse.data);

    // If the response indicates an unauthorized request (status 401), refresh the access token and retry.
    if (twitchResponse.status === 401) {
      console.log("Received 401 response. Refreshing access token and retrying...");
      await refreshAccessToken();
      accessToken = await getAccessToken();
      headers.Authorization = `Bearer ${accessToken}`;

      // Retry the GET request after refreshing the access token.
      const retryResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${streamerName}`, { headers });

      console.log(`Retry response for ${streamerName}:`, retryResponse.data);

      // If there's no data in the retry response, the streamer is not live.
      if (!retryResponse.data.data) return false;

      // Check if there's any live stream data for the streamer. If so, they are live.
      return retryResponse.data.data.length > 0;
    }

    // If there's no data in the initial response, the streamer is not live.
    if (!twitchResponse.data.data) return false;

    // Check if there's any live stream data for the streamer in the initial response. If so, they are live.
    return twitchResponse.data.data.length > 0;

  } catch (error) {
    // Log any errors encountered during the process.
    console.error('Error checking if streamer is live:', error);

    // If an error occurs, assume the streamer is not live.
    return false;
  }
}


// Track streamers we're currently checking the status for
/**
 * An object that tracks which streamers are currently being checked.
 * The keys represent the streamer's name, and the values (true or false) indicate whether 
 * the system is currently checking (or planning to check) the live status of that streamer.
 */
let currentlyChecking = {
  'olofmeister': true,  // Checking (or going to check) the live status of 'olofmeister'
  'f0rest': true        // Checking (or going to check) the live status of 'f0rest'
};


// Function to periodically check if certain streamers are live
/**
 * Asynchronously checks the live status of a list of streamers.
 * If a streamer is live, it fetches their rank. If they're not live, 
 * it marks them as not currently being checked. 
 * The function also schedules itself to run periodically.
 */
async function checkStreamers() {
  console.log('checkStreamers function called.');
  // Define a list of streamers to check.
  const streamers = ['olofmeister', 'f0rest'];

  // Loop through each streamer in the list.
  for (const streamer of streamers) {
    // If a streamer isn't flagged for checking, skip to the next streamer.
    if (!currentlyChecking[streamer]) continue;

    // Check if the current streamer is live.
    const live = await isStreamerLive(streamer);
    
    if (live) {
      // If the streamer is live, fetch their rank.
      await axios.get(`https://f0rest-rank-api.glitch.me/getRank/${streamer}`);
    } else {
      // If they're not live, set their status to not being checked.
      currentlyChecking[streamer] = false;
    }
  }

  // Determine if there are any streamers left to check.
  const shouldContinueChecking = Object.values(currentlyChecking).some(value => value);
  
  // If there are streamers left to check, schedule this function to run again after a delay.
  if (shouldContinueChecking) {
    setTimeout(checkStreamers, 4 * 60 * 1000); // Set to check every 4 minutes.
  }
}


// Kick off the streamer checking process when server starts
checkStreamers();  // Start the check when the server starts


// API endpoint to get a player's rank
// Express route handler for fetching the rank of a specified player.
app.get('/getRank/:playerName', async (req, res) => {
  console.log(`getRank API called for player: ${req.params.playerName}`);
  try {
    // Extract the player's name from the request parameters.
    const playerName = req.params.playerName;
    
    // Mark the player as "currently checking" and then check their streaming status.
    currentlyChecking[playerName] = true;
    checkStreamers();

    // Make a GET request to the Steam API using the player's name.
    const steamResponse = await axios.get('https://api.steampowered.com/ICSGOServers_730/GetLeaderboardEntries/v1', {
      params: {
        format: 'json',
        lbname: 'official_leaderboard_premier_season1',
      },
    });

    // Check if the response status code indicates a successful request.
    if (steamResponse.status !== 200) {
      return res.status(500).send('Failed to fetch data from the Steam API');
    }

    // Parse the returned data from the Steam API.
    const responseData = steamResponse.data;

    // Ensure the response contains the expected structure (a result with entries).
    if (!responseData || !responseData.result || !responseData.result.entries) {
      console.error('Invalid response from the Steam API:', responseData);
      return res.status(500).send('Invalid response from the Steam API');
    }

    // Extract the leaderboard entries from the response.
    const leaderboardEntries = responseData.result.entries;

    // Attempt to find the provided player's name within the leaderboard entries.
    let rank = null;
    for (const entry of leaderboardEntries) {
      if (entry.name === playerName) {
        rank = entry.rank;
        break;
      }
    }

    // If the player's rank wasn't found, respond with an appropriate message.
    if (rank === null) {
      return res.status(404).send(`Player "${playerName}" not found in the leaderboard`);
    }

    // If the rank was found, send the rank as the response.
    res.send(`${rank}`);
  } catch (error) {
    // Log any errors and respond with an appropriate error message.
    console.error('Error fetching rank:', error);
    res.status(500).send('An error occurred while fetching data from the Steam API');
  }
});

// Your token refresh test function
async function testTokenRefresh() {
  const MIN_TOKEN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  // Ensure you have an initial access token
  let accessToken = await getAccessToken();

  console.log('Initial access token for token refresh test:', accessToken);

  // Check if the access token is about to expire or has expired
  if (!accessToken || tokenStore.tokenExpiry - Date.now() < MIN_TOKEN_EXPIRY_MS) {
    console.log('Refreshing token...');
    await refreshAccessToken();
    accessToken = tokenStore.accessToken;
    console.log('New access token after refresh:', accessToken);
  }

  // Now you can make API calls using the refreshed token
  const streamerName = 'some_streamer';
  const isLive = await isStreamerLive(streamerName);

  if (isLive) {
    console.log(`${streamerName} is live!`);
  } else {
    console.log(`${streamerName} is not live.`);
  }
}

// Run the token refresh test
testTokenRefresh();

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});