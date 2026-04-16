import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import axios from 'axios';
import path from 'path';

let cachedToken: string | null = null;
let tokenExpiry: number | null = null;

async function getOpenSkyToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SEC;

  if (!clientId || !clientSecret) {
    console.warn(`Missing credentials. OPENSKY_CLIENT_ID exists: ${!!clientId}, OPENSKY_CLIENT_SEC exists: ${!!clientSecret}`);
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
        timeout: 5000 // 5 second timeout for token
      }
    );

    cachedToken = response.data.access_token;
    // Token expires in `expires_in` seconds. Subtract 60 seconds for safety margin.
    const expiresIn = response.data.expires_in || 1800;
    tokenExpiry = Date.now() + (expiresIn - 60) * 1000;

    return cachedToken;
  } catch (error: any) {
    console.error('Error fetching OpenSky token:', error.message);
    throw error;
  }
}

async function getFlightRadar24Data(lamin: any, lomin: any, lamax: any, lomax: any) {
  let url = 'https://data-cloud.flightradar24.com/zones/fcgi/bounds.json';
  if (lamin && lomin && lamax && lomax) {
    // FR24 format: north,south,west,east
    url += `?bounds=${lamax},${lamin},${lomin},${lomax}`;
  } else {
    // Default bounds if none provided (Europe)
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
        f[0] || key, // icao24
        f[16] || f[13] || 'Unknown', // callsign
        f[11] && f[12] ? `${f[11]} ✈ ${f[12]}` : (f[8] || 'Unknown'), // origin_country (using route or aircraft type)
        f[10], // time_position
        f[10], // last_contact
        f[2], // longitude
        f[1], // latitude
        f[4] * 0.3048, // baro_altitude (feet to meters)
        f[14] === 1, // on_ground
        f[5] * 0.514444, // velocity (knots to m/s)
        f[3], // true_track
        f[15] * 0.00508, // vertical_rate (fpm to m/s)
        null, // sensors
        f[4] * 0.3048, // geo_altitude
        f[6], // squawk
        false, // spi
        0, // position_source
        0, // category
        key // fr24_id (index 18)
      ];
    });

  return {
    time: Math.floor(Date.now() / 1000),
    states,
    _source: 'flightradar24'
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get('/api/flights', async (req, res) => {
    const { lamin, lomin, lamax, lomax, api = 'opensky' } = req.query;
    
    if (api === 'flightradar24') {
      try {
        const data = await getFlightRadar24Data(lamin, lomin, lamax, lomax);
        return res.json(data);
      } catch (error: any) {
        console.error('Error fetching from FlightRadar24:', error.message);
        return res.status(500).json({ 
          error: `FlightRadar24 API error: ${error.message}`
        });
      }
    }

    // OpenSky Network Logic (Default)
    const clientId = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SEC;
    
    try {
      let token = null;
      try {
        if (clientId && clientSecret) {
          token = await getOpenSkyToken();
        }
      } catch (tokenError: any) {
        console.warn('Failed to get OpenSky token, falling back to anonymous access:', tokenError.message);
      }
      
      let url = 'https://opensky-network.org/api/states/all';
      
      if (lamin && lomin && lamax && lomax) {
        url += `?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
      }

      const headers: any = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await axios.get(url, {
        headers,
        timeout: 5000 // 5 second timeout
      });

      const responseData = {
        ...response.data,
        _source: 'opensky',
        _warning: !token ? 'Using anonymous access (rate limited) due to token fetch failure or missing credentials.' : undefined
      };

      res.json(responseData);
    } catch (error: any) {
      console.error('Error fetching flights from OpenSky:', error.message);
      console.log('Falling back to FlightRadar24 automatically...');
      
      try {
        const fallbackData = await getFlightRadar24Data(lamin, lomin, lamax, lomax);
        return res.json({
          ...fallbackData,
          _warning: `OpenSky API timed out (${error.message}). Automatically fell back to FlightRadar24.`
        });
      } catch (fallbackError: any) {
        return res.status(500).json({ 
          error: `Both OpenSky and FlightRadar24 APIs failed. OpenSky: ${error.message}, FR24: ${fallbackError.message}`
        });
      }
    }
  });

  app.get('/api/weather', async (req, res) => {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }

    try {
      // Use Open-Meteo which is free and requires no API key, perfect for published apps
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
      
      const getOpenMeteoIcon = (code: number, isDay: boolean) => {
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

      const getWeatherDesc = (code: number) => {
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

      // Format to match OpenWeatherMap structure so frontend doesn't break
      const formattedData = {
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
        wind: {
          speed: current.wind_speed_10m
        },
        visibility: current.visibility || 10000,
        name: '', 
        sys: { country: '' }
      };

      res.json(formattedData);
    } catch (error: any) {
      console.error('Error fetching weather from Open-Meteo:', error.message);
      return res.status(500).json({ error: `Weather API error: ${error.message}` });
    }
  });

  // Weather Radar Tile Proxy
  app.get('/api/weather/tile/:layer/:z/:x/:y', async (req, res) => {
    const { layer, z, x, y } = req.params;
    const apiKey = process.env.OPENWEATHER_API_KEY;

    // Transparent 1x1 PNG to return on error or missing key so Leaflet doesn't show broken images
    const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

    if (!apiKey) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': transparentPng.length });
      return res.end(transparentPng);
    }

    try {
      const url = `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${apiKey}`;
      const response = await axios.get(url, { 
        responseType: 'stream', 
        timeout: 5000 
      });
      
      res.set('Content-Type', 'image/png');
      response.data.pipe(res);
    } catch (error) {
      // On error (e.g. 401 Unauthorized), return transparent tile
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': transparentPng.length });
      res.end(transparentPng);
    }
  });

  // Flight Details (Trail and Route)
  app.get('/api/flight-details', async (req, res) => {
    const { fr24_id } = req.query;
    
    if (!fr24_id) {
      return res.status(400).json({ error: 'fr24_id is required' });
    }

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
    } catch (error: any) {
      console.error('Error fetching flight details:', error.message);
      res.status(500).json({ error: 'Failed to fetch flight details' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
