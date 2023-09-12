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

    // Extract the rank for the player "f0rest"
    const leaderboardEntries = responseData.result.entries;

    // Find the player with the name "f0rest"
    let rank = null;
    for (const entry of leaderboardEntries) {
      if (entry.name === 'f0rest') {
        rank = entry.rank;
        break;
      }
    }

    if (rank === null) {
      return res.status(404).send('Player "f0rest" not found in the leaderboard');
    }

    // Send the rank as a JSON response
    res.json({ rank });
  } catch (error) {
    console.error('Error fetching rank:', error);
    res.status(500).send('An error occurred while fetching data from the Steam API');
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
