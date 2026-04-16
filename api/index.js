const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();

let cachedToken = null;
let tokenExpiry = null;

async function getOpenSkyToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SEC;

  if (!clientId || !clientSecret) {
    throw new Error('OpenSky credentials not found in environment variables');
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const response = await axios.post(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 5000 
      }
    );

    cachedToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 1800;
    tokenExpiry = Date.now() + (expiresIn - 60) * 1000;

    return cachedToken;
  } catch (error) {
    throw error;
  }
}

async function getFlightRadar24Data(lamin, lomin, lamax, lomax) {
  let url = 'https://data-cloud.flightradar24.com/zones/fcgi/bounds.json';
  if (lamin && lomin && lamax && lomax) {
    url += `?bounds=${lamax},${lamin},${lomin},${lomax}`;
  } else {
    url += `?bounds=60,35,-10,30`;
  }

  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.flightradar24.com/'
    },
    timeout: 8000
  });

  const states = Object.keys(response.data)
    .filter(key => key !== 'full_count' && key !== 'version')
    .map(key => {
      const f = response.data[key];
      return [
        f[0] || key, 
        f[16] || f[13] || 'Unknown', 
        f[11] && f[12] ? `${f[11]} ✈ ${f[12]}` : (f[8] || 'Unknown'), 
        f[10], 
        f[10], 
        f[2], 
        f[1], 
        f[4] * 0.3048, 
        f[14] === 1, 
        f[5] * 0.514444, 
        f[3], 
        f[15] * 0.00508, 
        null, 
        f[4] * 0.3048, 
        f[6], 
        false, 
        0, 
        0, 
        key 
      ];
    });

  return {
    time: Math.floor(Date.now() / 1000),
    states,
    _source: 'flightradar24'
  };
}

app.get('/api/flights', async (req, res) => {
  const { lamin, lomin, lamax, lomax, api = 'opensky' } = req.query;
  
  if (api === 'flightradar24') {
    try {
      const data = await getFlightRadar24Data(lamin, lomin, lamax, lomax);
      return res.json(data);
    } catch (error) {
      return res.status(500).json({ error: `FlightRadar24 API error: ${error.message}` });
    }
  }

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SEC;
  
  try {
    let token = null;
    try {
      if (clientId && clientSecret) {
        token = await getOpenSkyToken();
      }
    } catch (tokenError) {
      console.warn('Failed to get OpenSky token', tokenError.message);
    }
    
    let url = 'https://opensky-network.org/api/states/all';
    
    if (lamin && lomin && lamax && lomax) {
      url += `?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
    }

    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await axios.get(url, { headers, timeout: 5000 });

    res.json({
      ...response.data,
      _source: 'opensky',
      _warning: !token ? 'Using anonymous access (rate limited).' : undefined
    });
  } catch (error) {
    try {
      const fallbackData = await getFlightRadar24Data(lamin, lomin, lamax, lomax);
      return res.json({
        ...fallbackData,
        _warning: `OpenSky API timed out. Automatically fell back to FlightRadar24.`
      });
    } catch (fallbackError) {
      return res.status(500).json({ error: `Both APIs failed.` });
    }
  }
});

app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Latitude and longitude are required.' });

  try {
    const response = await axios.get(`https://api.open-meteo.com/v1/forecast`, {
      params: {
        latitude: lat,
        longitude: lon,
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,surface_pressure,wind_speed_10m,visibility',
        wind_speed_unit: 'ms'
      },
      timeout: 5000
    });

    const current = response.data.current;
    const isDay = current.is_day === 1;
    
    const getOpenMeteoIcon = (code, isDay) => {
      const d = isDay ? 'd' : 'n';
      if (code === 0) return `01${d}`;
      if (code === 1) return `02${d}`;
      if (code === 2) return `03${d}`;
      if (code === 3) return `04${d}`;
      if (code === 45 || code === 48) return `50${d}`;
      if ([51, 53, 55, 56, 57, 80, 81, 82].includes(code)) return `09${d}`;
      if ([61, 63, 65].includes(code)) return `10${d}`;
      if ([66, 67, 71, 73, 75, 77, 85, 86].includes(code)) return `13${d}`;
      if ([95, 96, 99].includes(code)) return `11${d}`;
      return `01${d}`;
    };

    const getWeatherDesc = (code) => {
      if (code === 0) return 'Clear sky';
      if (code === 1) return 'Mainly clear';
      if (code === 2) return 'Partly cloudy';
      if (code === 3) return 'Overcast';
      if (code === 45 || code === 48) return 'Fog';
      if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
      if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
      if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
      if ([95, 96, 99].includes(code)) return 'Thunderstorm';
      return 'Unknown';
    };

    res.json({
      weather: [{
        main: getWeatherDesc(current.weather_code),
        description: getWeatherDesc(current.weather_code).toLowerCase(),
        icon: getOpenMeteoIcon(current.weather_code, isDay)
      }],
      main: {
        temp: current.temperature_2m,
        feels_like: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        pressure: current.surface_pressure
      },
      wind: { speed: current.wind_speed_10m },
      visibility: current.visibility || 10000,
      name: '', 
      sys: { country: '' }
    });
  } catch (error) {
    return res.status(500).json({ error: `Weather API error: ${error.message}` });
  }
});

app.get('/api/weather/tile/:layer/:z/:x/:y', async (req, res) => {
  const { layer, z, x, y } = req.params;
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

  if (!apiKey) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': transparentPng.length });
    return res.end(transparentPng);
  }

  try {
    const url = `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${apiKey}`;
    const response = await axios.get(url, { responseType: 'stream', timeout: 5000 });
    res.set('Content-Type', 'image/png');
    response.data.pipe(res);
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': transparentPng.length });
    res.end(transparentPng);
  }
});

app.get('/api/flight-details', async (req, res) => {
  const { fr24_id } = req.query;
  if (!fr24_id) return res.status(400).json({ error: 'fr24_id is required' });

  try {
    const response = await axios.get(`https://data-live.flightradar24.com/clickhandler/?version=1.5&flight=${fr24_id}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.flightradar24.com/'
      },
      timeout: 5000
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch flight details' });
  }
});

module.exports = app;
