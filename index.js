require('dotenv').config();

const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 5000;

// Serve static files from the current directory
app.use(express.static('.'));

// Route to serve the game and handle health checks
app.get('/', (req, res) => {
  // Check if this is a health check request (typically has specific user agents or headers)
  const userAgent = req.get('User-Agent') || '';
  if (userAgent.includes('GoogleHC') || userAgent.includes('health') || req.get('X-Health-Check')) {
    res.status(200).send('OK');
  } else {
    res.sendFile(path.join(__dirname, 'app.html'));
  }
});

// Test route
app.get('/test', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
  console.log('Game is now accessible!');
});
