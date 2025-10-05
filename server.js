import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ------------------------- MOCK DATA -------------------------
const cityData = {
  'New York, NY': { aqi: 78, category: 'moderate', pollutants: { pm25: { value: 12.3, unit: 'µg/m³', status: 'Good' } } },
  'Delhi, India': { aqi: 245, category: 'very-unhealthy', pollutants: { pm25: { value: 45.6, unit: 'µg/m³', status: 'Very Unhealthy' } } },
  'London, UK': { aqi: 55, category: 'moderate', pollutants: { pm25: { value: 11.2, unit: 'µg/m³', status: 'Good' } } },
  // (keep your other cities unchanged)
};

// ------------------------- HELPERS -------------------------
function getAQICategory(aqi) {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'unhealthy-sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very-unhealthy';
  return 'hazardous';
}

function getStatusFromValue(pollutant, value) {
  const thresholds = {
    pm25: { good: 12, moderate: 35 },
    pm10: { good: 54, moderate: 154 },
    o3: { good: 54, moderate: 70 },
    no2: { good: 53, moderate: 100 },
    so2: { good: 35, moderate: 75 },
    co: { good: 4.4, moderate: 9.4 }
  };

  if (value <= thresholds[pollutant]?.good) return 'Good';
  if (value <= thresholds[pollutant]?.moderate) return 'Moderate';
  return 'Unhealthy';
}

function generateForecast(baseAqi, location) {
  const days = ['Today', 'Tomorrow', 'Wed', 'Thu', 'Fri', 'Sat'];
  const forecast = [];
  const factor = { variation: 20, trend: 1.05 };

  let currentAqi = baseAqi;
  days.forEach(day => {
    const variation = (Math.random() - 0.5) * factor.variation;
    currentAqi = Math.max(10, Math.min(400, currentAqi * factor.trend + variation));

    forecast.push({
      day,
      aqi: Math.round(currentAqi),
      category: getAQICategory(currentAqi)
    });
  });

  return forecast;
}

function generateHealthRecommendations(aqi) {
  if (aqi <= 50) return ['Ideal air quality for outdoor activities'];
  if (aqi <= 100) return ['Air quality is acceptable for most people'];
  if (aqi <= 150) return ['Sensitive groups should reduce outdoor activities'];
  if (aqi <= 200) return ['Everyone may experience health effects'];
  return ['Health warnings — avoid outdoor activities'];
}

// ------------------------- FIXED API (v3) -------------------------
async function getOpenAQData(location) {
  try {
    const cityName = location.split(',')[0].trim();
    const response = await axios.get(`https://api.openaq.org/v3/measurements`, {
      params: {
        city: cityName,
        limit: 5,
        sort: 'desc',
        order_by: 'datetime'
      }
    });

    if (response.data.results && response.data.results.length > 0) {
      const latestData = response.data.results[0];
      const pollutants = {};

      response.data.results.forEach(m => {
        pollutants[m.parameter] = {
          value: m.value,
          unit: m.unit,
          status: getStatusFromValue(m.parameter, m.value)
        };
      });

      const pm25 = pollutants.pm25?.value || 15;
      const calculatedAqi = Math.min(500, Math.max(0, pm25 * 5));

      return {
        aqi: Math.round(calculatedAqi),
        category: getAQICategory(calculatedAqi),
        location: `${cityName}`,
        pollutants,
        lastUpdated: latestData.datetime
      };
    }
  } catch (error) {
    console.log('OpenAQ API error:', error.message);
  }
  return null;
}

// ------------------------- MAIN FUNCTION -------------------------
async function getAirQualityData(location = 'New York, NY') {
  const openAQData = await getOpenAQData(location);
  if (openAQData) {
    openAQData.forecast = generateForecast(openAQData.aqi, location);
    openAQData.healthRecommendations = generateHealthRecommendations(openAQData.aqi);
    return openAQData;
  }

  const fallback = cityData[location] || cityData['New York, NY'];
  const variation = (Math.random() - 0.5) * 10;
  const currentAqi = Math.max(0, fallback.aqi + variation);

  return {
    aqi: Math.round(currentAqi),
    category: getAQICategory(currentAqi),
    location,
    pollutants: fallback.pollutants,
    forecast: generateForecast(currentAqi, location),
    healthRecommendations: generateHealthRecommendations(currentAqi),
    lastUpdated: new Date().toISOString()
  };
}

// ------------------------- ROUTES -------------------------
app.get('/api/air-quality', async (req, res) => {
  const location = req.query.location || 'New York, NY';
  const data = await getAirQualityData(location);
  res.json(data);
});

app.get('/api/forecast', async (req, res) => {
  const location = req.query.location || 'New York, NY';
  const data = await getAirQualityData(location);
  res.json(data.forecast);
});

app.get('/api/locations', (req, res) => {
  res.json(Object.keys(cityData));
});

app.get('/api/health', (req, res) => {
  const aqi = parseInt(req.query.aqi) || 50;
  res.json({ recommendations: generateHealthRecommendations(aqi) });
});

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ------------------------- WEBSOCKET -------------------------
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  console.log('New WebSocket client connected');
  getAirQualityData('New York, NY').then(data => ws.send(JSON.stringify({ type: 'initial', data })));
  const interval = setInterval(async () => {
    const data = await getAirQualityData('New York, NY');
    ws.send(JSON.stringify({ type: 'update', data }));
  }, 30000);
  ws.on('close', () => clearInterval(interval));
});

// ------------------------- START SERVER -------------------------
app.listen(PORT, () => {
  console.log(`🚀 Air Quality Backend Server running on port ${PORT}`);
  console.log(`📍 API Base URL: http://localhost:${PORT}`);
  console.log(`🌍 Air Quality API: http://localhost:${PORT}/api/air-quality`);
  console.log(`🗺️  Locations API: http://localhost:${PORT}/api/locations`);
  console.log(`📡 WebSocket Server: ws://localhost:8080`);
  console.log(`📊 Frontend: http://localhost:${PORT}`);
});
