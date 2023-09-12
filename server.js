const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Define a route to fetch the rank from the Steam API
app.get('/getRank', async (req, res) => {
  try {
    // Make a GET request to the Steam API
    const steamResponse = await axios.get('https://api.steampowered.com/ICSGOServers_730/GetLeaderboardEntries/v1', {
      params: {
        format: 'json',
        lbname: 'official_leaderboard_premier_season1',
      },
    });

    // Extract the rank for the player "f0rest"
    const leaderboardEntries = steamResponse.data.leaderboard_entries;
    const player = leaderboardEntries.find(entry => entry.name === 'f0rest');

    if (!player) {
      return res.status(404).send('Player "f0rest" not found in the leaderboard');
    }

    // Extract the rank value
    const rank = player.rank;

    // Send the rank as a JSON response
    res.json({ rank });
  } catch (error) {
    console.error('Error fetching rank:', error);
    res.status(500).send('An error occurred while fetching data from the Steam API');
  }
});

// Define a route for testing
app.get('/test', (req, res) => {
  res.send('API is working!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
