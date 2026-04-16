import React, { useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import axios from 'axios';
import { Plane, Navigation, Activity, Clock, Info, Filter, Search, X, Eye, EyeOff, Cloud, Thermometer, Wind, Droplets, Gauge, Layers } from 'lucide-react';

// Fix Leaflet's default icon path issues
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Custom plane icon
const createPlaneIcon = (rotation: number) => {
  return L.divIcon({
    className: 'plane-icon',
    html: `<div style="transform: rotate(${rotation}deg); width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">
             <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#3b82f6" stroke="#1e3a8a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plane"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.2-1.1.7l-1.2 3.3c-.2.5.1 1 .6 1.1l7.3 2-2.8 2.8-3.2-.8c-.5-.1-.9.2-1.1.7l-.8 2.3c-.2.5.1 1 .6 1.1l4 .8 2.8 2.8c.1.5.6.8 1.1.6l2.3-.8c.5-.2.8-.6.7-1.1l-.8-3.2 2.8-2.8 2 7.3c.1.5.6.8 1.1.6l3.3-1.2c.5-.2.8-.6.7-1.1Z"/></svg>
           </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
};

interface Flight {
  icao24: string;
  callsign: string;
  origin_country: string;
  time_position: number;
  last_contact: number;
  longitude: number;
  latitude: number;
  baro_altitude: number;
  on_ground: boolean;
  velocity: number;
  true_track: number;
  vertical_rate: number;
  sensors: number[];
  geo_altitude: number;
  squawk: string;
  spi: boolean;
  position_source: number;
  category: number;
  fr24_id?: string;
}

const MapUpdater = ({ setBounds }: { setBounds: (bounds: any) => void }) => {
  const map = useMap();
  
  useEffect(() => {
    const updateBounds = () => {
      const newBounds = map.getBounds();
      setBounds((prev: any) => {
        const lamin = newBounds.getSouth();
        const lomin = newBounds.getWest();
        const lamax = newBounds.getNorth();
        const lomax = newBounds.getEast();
        
        // Prevent state update if bounds haven't changed
        if (prev && 
            prev.lamin === lamin && 
            prev.lomin === lomin && 
            prev.lamax === lamax && 
            prev.lomax === lomax) {
          return prev;
        }
        
        return { lamin, lomin, lamax, lomax };
      });
    };

    map.on('moveend', updateBounds);
    updateBounds(); // Initial bounds

    return () => {
      map.off('moveend', updateBounds);
    };
  }, [map, setBounds]);

  return null;
};

export default function FlightMap() {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [bounds, setBounds] = useState<any>(null);
  const [selectedFlight, setSelectedFlight] = useState<Flight | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const [dataSource, setDataSource] = useState<'opensky' | 'flightradar24'>('flightradar24');
  const [isolateSelected, setIsolateSelected] = useState(false);

  // Weather state
  const [weather, setWeather] = useState<any>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [weatherLayer, setWeatherLayer] = useState<string>('none');
  const [rainViewerPath, setRainViewerPath] = useState<string | null>(null);

  // Flight trail state
  const [flightTrail, setFlightTrail] = useState<[number, number][]>([]);
  const [flightOrigin, setFlightOrigin] = useState<[number, number] | null>(null);
  const [flightDestination, setFlightDestination] = useState<[number, number] | null>(null);

  // Fetch latest RainViewer timestamp for the free radar
  useEffect(() => {
    axios.get('https://api.rainviewer.com/public/weather-maps.json')
      .then(res => {
        const past = res.data.radar.past;
        if (past && past.length > 0) {
          setRainViewerPath(past[past.length - 1].path);
        }
      })
      .catch(err => console.error('Failed to fetch RainViewer data', err));
  }, []);

  // Filter states
  const [showFilters, setShowFilters] = useState(false);
  const [filterCallsign, setFilterCallsign] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterMinAlt, setFilterMinAlt] = useState<number | ''>('');
  const [filterMaxAlt, setFilterMaxAlt] = useState<number | ''>('');
  const [filterMinSpeed, setFilterMinSpeed] = useState<number | ''>('');

  // Use a stringified version of bounds for the dependency array to prevent infinite loops
  // caused by new object references.
  const boundsString = bounds ? `${bounds.lamin},${bounds.lomin},${bounds.lamax},${bounds.lomax}` : null;

  const fetchFlights = async () => {
    if (!bounds) return;
    
    try {
      setLoading(true);
      const response = await axios.get('/api/flights', {
        params: {
          ...bounds,
          api: dataSource
        }
      });
      
      if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
         setError('Backend API not configured correctly on host server.');
         setFlights([]);
         return;
      }

      if (response.data && response.data.states) {
        if (response.data._warning) {
          setWarning(response.data._warning);
        } else {
          setWarning(null);
        }
        
        const parsedFlights = response.data.states.map((state: any) => ({
          icao24: state[0],
          callsign: state[1]?.trim() || 'Unknown',
          origin_country: state[2],
          time_position: state[3],
          last_contact: state[4],
          longitude: state[5],
          latitude: state[6],
          baro_altitude: state[7],
          on_ground: state[8],
          velocity: state[9],
          true_track: state[10],
          vertical_rate: state[11],
          sensors: state[12],
          geo_altitude: state[13],
          squawk: state[14],
          spi: state[15],
          position_source: state[16],
          category: state[17],
          fr24_id: state[18],
        })).filter((f: Flight) => f.latitude !== null && f.longitude !== null);
        
        setFlights(parsedFlights);
        setLastUpdated(new Date());
        setError(null);
      } else {
        setFlights([]);
      }
    } catch (err: any) {
      console.error('Failed to fetch flights:', err);
      setError(err.response?.data?.error || 'Failed to fetch flight data. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!boundsString) return;
    
    fetchFlights();
    // Refresh every 10 seconds
    const interval = setInterval(fetchFlights, 10000);
    return () => clearInterval(interval);
  }, [boundsString, dataSource]);

  // Keep selected flight updated with latest data
  useEffect(() => {
    setSelectedFlight(prev => {
      if (!prev) return prev;
      const updated = flights.find(f => f.icao24 === prev.icao24);
      // Only update if the data actually changed to prevent infinite re-renders
      if (updated && updated.time_position !== prev.time_position) {
        return updated;
      }
      return prev;
    });
  }, [flights]);

  // Fetch weather when a flight is selected
  useEffect(() => {
    if (!selectedFlight) {
      setWeather(null);
      setWeatherError(null);
      return;
    }

    const fetchWeather = async () => {
      try {
        setWeatherLoading(true);
        setWeatherError(null);
        const response = await axios.get('/api/weather', {
          params: {
            lat: selectedFlight.latitude,
            lon: selectedFlight.longitude
          }
        });

        if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
          setWeatherError('Weather API not available on this domain.');
          setWeather(null);
          return;
        }

        setWeather(response.data);
      } catch (err: any) {
        console.error('Failed to fetch weather:', err);
        setWeatherError(err.response?.data?.error || 'Failed to fetch weather data.');
      } finally {
        setWeatherLoading(false);
      }
    };

    fetchWeather();
  }, [selectedFlight?.icao24]); // Only trigger when the selected flight changes, not on every position update

  // Fetch flight trail and route when a flight is selected
  useEffect(() => {
    if (!selectedFlight || !selectedFlight.fr24_id) {
      setFlightTrail([]);
      setFlightOrigin(null);
      setFlightDestination(null);
      return;
    }

    const fetchTrail = async () => {
      try {
        const response = await axios.get('/api/flight-details', {
          params: { fr24_id: selectedFlight.fr24_id }
        });
        
        if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
          setFlightTrail([]);
          setFlightOrigin(null);
          setFlightDestination(null);
          return;
        }

        const data = response.data;
        
        // Parse historical trail
        if (data.trail && Array.isArray(data.trail)) {
          // The trail is usually ordered from newest to oldest or oldest to newest.
          // Let's just map it to [lat, lng] pairs.
          const trailCoords: [number, number][] = data.trail.map((point: any) => [point.lat, point.lng]);
          setFlightTrail(trailCoords);
        } else {
          setFlightTrail([]);
        }

        // Parse planned route (origin to destination)
        if (data.airport?.origin?.position) {
          setFlightOrigin([data.airport.origin.position.latitude, data.airport.origin.position.longitude]);
        } else {
          setFlightOrigin(null);
        }

        if (data.airport?.destination?.position) {
          setFlightDestination([data.airport.destination.position.latitude, data.airport.destination.position.longitude]);
        } else {
          setFlightDestination(null);
        }

      } catch (err) {
        console.error('Failed to fetch flight trail:', err);
        setFlightTrail([]);
        setFlightOrigin(null);
        setFlightDestination(null);
      }
    };

    fetchTrail();
  }, [selectedFlight?.icao24, selectedFlight?.fr24_id]);

  // Apply filters
  const filteredFlights = flights.filter(f => {
    if (filterCallsign && !f.callsign.toLowerCase().includes(filterCallsign.toLowerCase())) return false;
    if (filterCountry && !f.origin_country.toLowerCase().includes(filterCountry.toLowerCase())) return false;
    if (filterMinAlt !== '' && (f.baro_altitude === null || f.baro_altitude < filterMinAlt)) return false;
    if (filterMaxAlt !== '' && (f.baro_altitude === null || f.baro_altitude > filterMaxAlt)) return false;
    if (filterMinSpeed !== '' && (f.velocity === null || (f.velocity * 3.6) < filterMinSpeed)) return false;
    return true;
  });

  // Determine which flights to display on the map
  const displayFlights = isolateSelected && selectedFlight
    ? flights.filter(f => f.icao24 === selectedFlight.icao24)
    : filteredFlights;

  return (
    <div className="relative w-full h-screen flex">
      {/* Map Area */}
      <div className="flex-1 relative z-0">
        <MapContainer center={[41.9028, 12.4964]} zoom={6} className="w-full h-full">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          />
          
          {/* Weather Radar Layer (OpenWeatherMap - Requires API Key) */}
          {weatherLayer !== 'none' && weatherLayer !== 'rainviewer' && (
            <TileLayer
              key={weatherLayer}
              url={`/api/weather/tile/${weatherLayer}/{z}/{x}/{y}`}
              opacity={0.6}
              maxZoom={18}
            />
          )}

          {/* RainViewer Layer (Free, no API key required, works in public links) */}
          {weatherLayer === 'rainviewer' && rainViewerPath && (
            <TileLayer
              key={`rv-${rainViewerPath}`}
              url={`https://tilecache.rainviewer.com${rainViewerPath}/256/{z}/{x}/{y}/2/1_1.png`}
              opacity={0.6}
              maxZoom={18}
            />
          )}

          {/* Flight Route (Planned) */}
          {selectedFlight && (flightOrigin || flightDestination) && (
            <Polyline 
              positions={[
                ...(flightOrigin ? [flightOrigin] : []),
                [selectedFlight.latitude, selectedFlight.longitude],
                ...(flightDestination ? [flightDestination] : [])
              ]} 
              pathOptions={{ color: '#9ca3af', weight: 2, dashArray: '5, 10', opacity: 0.8 }} 
            />
          )}

          {/* Flight Trail (Real historical path) */}
          {selectedFlight && flightTrail.length > 0 && (
            <Polyline 
              positions={[...flightTrail, [selectedFlight.latitude, selectedFlight.longitude]]} 
              pathOptions={{ color: '#3b82f6', weight: 3, opacity: 0.8 }} 
            />
          )}

          <MapUpdater setBounds={setBounds} />
          
          {displayFlights.map((flight) => (
            <Marker
              key={flight.icao24}
              position={[flight.latitude, flight.longitude]}
              icon={createPlaneIcon(flight.true_track || 0)}
              eventHandlers={{
                click: () => setSelectedFlight(flight),
              }}
            >
              <Popup>
                <div className="font-sans">
                  <h3 className="font-bold text-lg mb-1">{flight.callsign}</h3>
                  <p className="text-sm text-gray-600 mb-2">{flight.origin_country}</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><strong>Alt:</strong> {flight.baro_altitude ? Math.round(flight.baro_altitude) + 'm' : 'N/A'}</div>
                    <div><strong>Spd:</strong> {flight.velocity ? Math.round(flight.velocity * 3.6) + 'km/h' : 'N/A'}</div>
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {/* Top Overlay Controls */}
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[1000] flex flex-col items-center gap-2">
          <div className="bg-white/90 backdrop-blur-sm px-6 py-3 rounded-full shadow-lg border border-gray-200 flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Plane className="w-5 h-5 text-blue-500" />
              <span className="font-semibold text-gray-800">{filteredFlights.length} Flights</span>
            </div>
            <div className="w-px h-6 bg-gray-300"></div>
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Clock className="w-4 h-4" />
              <span>Updated: {lastUpdated.toLocaleTimeString()}</span>
            </div>
            <div className="w-px h-6 bg-gray-300"></div>
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-500" />
              <select 
                value={weatherLayer} 
                onChange={(e) => setWeatherLayer(e.target.value)}
                className="bg-transparent border-none text-sm font-medium text-gray-700 focus:ring-0 cursor-pointer outline-none"
              >
                <option value="none">No Radar</option>
                <option value="rainviewer">Precipitation (Free/Public)</option>
                <optgroup label="Requires API Key">
                  <option value="precipitation_new">Precipitation (OWM)</option>
                  <option value="clouds_new">Clouds</option>
                  <option value="temp_new">Temperature</option>
                  <option value="wind_new">Wind Speed</option>
                  <option value="pressure_new">Pressure</option>
                </optgroup>
              </select>
            </div>
            <div className="w-px h-6 bg-gray-300"></div>
            <div className="flex items-center gap-2">
              <select 
                value={dataSource} 
                onChange={(e) => setDataSource(e.target.value as 'opensky' | 'flightradar24')}
                className="bg-transparent border-none text-sm font-medium text-gray-700 focus:ring-0 cursor-pointer outline-none"
              >
                <option value="flightradar24">FlightRadar24</option>
                <option value="opensky">OpenSky Network</option>
              </select>
            </div>
            <div className="w-px h-6 bg-gray-300"></div>
            <button 
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${showFilters ? 'text-blue-600' : 'text-gray-700 hover:text-blue-600'}`}
            >
              <Filter className="w-4 h-4" />
              Filters
              {(filterCallsign || filterCountry || filterMinAlt !== '' || filterMaxAlt !== '' || filterMinSpeed !== '') && (
                <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              )}
            </button>
            {loading && (
              <>
                <div className="w-px h-6 bg-gray-300"></div>
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <Activity className="w-4 h-4 animate-spin" />
                  <span>Updating...</span>
                </div>
              </>
            )}
          </div>

          {/* Filter Panel */}
          {showFilters && (
            <div className="bg-white/95 backdrop-blur-md p-4 rounded-2xl shadow-xl border border-gray-200 w-[400px] mt-2">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <Search className="w-4 h-4" /> Search & Filter
                </h3>
                <button 
                  onClick={() => {
                    setFilterCallsign('');
                    setFilterCountry('');
                    setFilterMinAlt('');
                    setFilterMaxAlt('');
                    setFilterMinSpeed('');
                  }}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  Clear All
                </button>
              </div>
              
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Callsign</label>
                    <input 
                      type="text" 
                      placeholder="e.g. RYR, AFR" 
                      value={filterCallsign}
                      onChange={(e) => setFilterCallsign(e.target.value)}
                      className="w-full text-sm px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
                    <input 
                      type="text" 
                      placeholder="e.g. Italy, France" 
                      value={filterCountry}
                      onChange={(e) => setFilterCountry(e.target.value)}
                      className="w-full text-sm px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Min Altitude (m)</label>
                    <input 
                      type="number" 
                      placeholder="0" 
                      value={filterMinAlt}
                      onChange={(e) => setFilterMinAlt(e.target.value ? Number(e.target.value) : '')}
                      className="w-full text-sm px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Max Altitude (m)</label>
                    <input 
                      type="number" 
                      placeholder="15000" 
                      value={filterMaxAlt}
                      onChange={(e) => setFilterMaxAlt(e.target.value ? Number(e.target.value) : '')}
                      className="w-full text-sm px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Min Speed (km/h)</label>
                  <input 
                    type="number" 
                    placeholder="0" 
                    value={filterMinSpeed}
                    onChange={(e) => setFilterMinSpeed(e.target.value ? Number(e.target.value) : '')}
                    className="w-full text-sm px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-[1000] bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded shadow-md">
            {error}
          </div>
        )}

        {/* Warning Message */}
        {warning && !error && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-[1000] bg-yellow-100 border border-yellow-400 text-yellow-800 px-4 py-3 rounded shadow-md text-sm">
            {warning}
          </div>
        )}
      </div>

      {/* Sidebar for Selected Flight */}
      {selectedFlight && (
        <div className="w-80 bg-white shadow-2xl z-[1000] h-full flex flex-col border-l border-gray-200 overflow-y-auto">
          <div className="bg-blue-600 text-white p-6 relative">
            <button 
              onClick={() => {
                setSelectedFlight(null);
                setIsolateSelected(false);
              }}
              className="absolute top-4 right-4 text-white/80 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
            <h2 className="text-2xl font-bold mb-1">{selectedFlight.callsign}</h2>
            <p className="text-blue-100 flex items-center gap-2">
              <Navigation className="w-4 h-4" />
              {selectedFlight.origin_country}
            </p>
            
            <button
              onClick={() => setIsolateSelected(!isolateSelected)}
              className="mt-4 w-full flex items-center justify-center gap-2 bg-white/20 hover:bg-white/30 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              {isolateSelected ? (
                <>
                  <Eye className="w-4 h-4" />
                  Show All Flights
                </>
              ) : (
                <>
                  <EyeOff className="w-4 h-4" />
                  Isolate Flight
                </>
              )}
            </button>
          </div>
          
          <div className="p-6 flex-1">
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <div className="text-xs text-gray-500 uppercase font-semibold mb-1">Altitude</div>
                  <div className="text-xl font-bold text-gray-900">
                    {selectedFlight.baro_altitude ? `${Math.round(selectedFlight.baro_altitude)} m` : 'N/A'}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <div className="text-xs text-gray-500 uppercase font-semibold mb-1">Speed</div>
                  <div className="text-xl font-bold text-gray-900">
                    {selectedFlight.velocity ? `${Math.round(selectedFlight.velocity * 3.6)} km/h` : 'N/A'}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <div className="text-xs text-gray-500 uppercase font-semibold mb-1">Heading</div>
                  <div className="text-xl font-bold text-gray-900">
                    {selectedFlight.true_track ? `${Math.round(selectedFlight.true_track)}°` : 'N/A'}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <div className="text-xs text-gray-500 uppercase font-semibold mb-1">Vert. Rate</div>
                  <div className="text-xl font-bold text-gray-900">
                    {selectedFlight.vertical_rate ? `${selectedFlight.vertical_rate > 0 ? '+' : ''}${selectedFlight.vertical_rate} m/s` : 'N/A'}
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-100 pt-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <Info className="w-4 h-4 text-blue-500" />
                  Aircraft Details
                </h3>
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">ICAO 24-bit</dt>
                    <dd className="font-mono font-medium text-gray-900">{selectedFlight.icao24}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Squawk</dt>
                    <dd className="font-mono font-medium text-gray-900">{selectedFlight.squawk || 'N/A'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Status</dt>
                    <dd className="font-medium text-gray-900">
                      {selectedFlight.on_ground ? (
                        <span className="text-orange-600 bg-orange-50 px-2 py-1 rounded">On Ground</span>
                      ) : (
                        <span className="text-green-600 bg-green-50 px-2 py-1 rounded">In Air</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Last Contact</dt>
                    <dd className="font-medium text-gray-900">
                      {new Date(selectedFlight.last_contact * 1000).toLocaleTimeString()}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Weather Section */}
              <div className="border-t border-gray-100 pt-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-blue-500" />
                  Local Weather (at aircraft)
                </h3>
                
                {weatherLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Activity className="w-5 h-5 text-blue-500 animate-spin" />
                  </div>
                ) : weatherError ? (
                  <div className="text-sm text-red-500 bg-red-50 p-3 rounded-lg border border-red-100">
                    {weatherError}
                  </div>
                ) : weather ? (
                  <div className="space-y-4">
                    {weather._warning && (
                      <div className="text-xs text-yellow-700 bg-yellow-50 p-2 rounded border border-yellow-200">
                        {weather._warning}
                      </div>
                    )}
                    <div className="flex items-center gap-3 bg-blue-50 p-3 rounded-xl">
                      <img 
                        src={`https://openweathermap.org/img/wn/${weather.weather[0].icon}@2x.png`} 
                        alt={weather.weather[0].description}
                        className="w-12 h-12"
                      />
                      <div>
                        <div className="text-lg font-bold text-gray-900 capitalize">
                          {weather.weather[0].description}
                        </div>
                        <div className="text-sm text-gray-600">
                          {weather.name ? `${weather.name}, ${weather.sys?.country}` : 'Over open area'}
                        </div>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="flex items-center gap-2">
                        <Thermometer className="w-4 h-4 text-orange-500" />
                        <div>
                          <div className="text-gray-500 text-xs">Temp</div>
                          <div className="font-medium">{Math.round(weather.main.temp)}°C</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Thermometer className="w-4 h-4 text-red-500" />
                        <div>
                          <div className="text-gray-500 text-xs">Feels Like</div>
                          <div className="font-medium">{Math.round(weather.main.feels_like)}°C</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Wind className="w-4 h-4 text-teal-500" />
                        <div>
                          <div className="text-gray-500 text-xs">Wind</div>
                          <div className="font-medium">{weather.wind.speed} m/s</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Droplets className="w-4 h-4 text-blue-400" />
                        <div>
                          <div className="text-gray-500 text-xs">Humidity</div>
                          <div className="font-medium">{weather.main.humidity}%</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Gauge className="w-4 h-4 text-purple-500" />
                        <div>
                          <div className="text-gray-500 text-xs">Pressure</div>
                          <div className="font-medium">{weather.main.pressure} hPa</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Eye className="w-4 h-4 text-gray-500" />
                        <div>
                          <div className="text-gray-500 text-xs">Visibility</div>
                          <div className="font-medium">{(weather.visibility / 1000).toFixed(1)} km</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
