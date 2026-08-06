/**
 * City autocomplete.
 *
 * CLAUDE.md §5: build a simple prefix index client-side, no search library. The
 * data is `public/data/cities.json`, produced by `tools/trim_geonames.py` and
 * sorted by population descending, so scanning in file order surfaces the place
 * most people mean first without any ranking logic.
 *
 * The file is several hundred KB and §11 budgets 400 KB gzipped for first load,
 * so it is fetched on demand — when the city field is first focused — never as
 * part of the initial bundle.
 */

/** Row shape in cities.json: [name, admin1, countryIndex, tzIndex, population]. */
type CityRow = [string, string, number, number, number];

interface CitiesJson {
  countries: string[];
  tz: string[];
  cities: CityRow[];
}

export interface City {
  name: string;
  /** State or region, already resolved to a name where the data allowed. */
  admin1: string;
  country: string;
  tzid: string;
  population: number;
}

/**
 * Enough of the world to keep the form usable when cities.json is missing or
 * its fetch fails — a city list is not worth a dead form over. Also what the
 * repo runs on before anyone has fetched the CC-BY GeoNames dump.
 */
const FALLBACK: [string, string, string, string, number][] = [
  ['Tokyo', 'Tōkyō', 'JP', 'Asia/Tokyo', 37400068],
  ['Delhi', 'Delhi', 'IN', 'Asia/Kolkata', 28514000],
  ['Shanghai', 'Shanghai', 'CN', 'Asia/Shanghai', 25582000],
  ['São Paulo', 'São Paulo', 'BR', 'America/Sao_Paulo', 21650000],
  ['Mexico City', 'Ciudad de México', 'MX', 'America/Mexico_City', 21581000],
  ['Cairo', 'Cairo', 'EG', 'Africa/Cairo', 20076000],
  ['Mumbai', 'Maharashtra', 'IN', 'Asia/Kolkata', 19980000],
  ['Beijing', 'Beijing', 'CN', 'Asia/Shanghai', 19618000],
  ['Dhaka', 'Dhaka', 'BD', 'Asia/Dhaka', 19578000],
  ['Osaka', 'Ōsaka', 'JP', 'Asia/Tokyo', 19281000],
  ['New York', 'New York', 'US', 'America/New_York', 18819000],
  ['Karachi', 'Sindh', 'PK', 'Asia/Karachi', 15400000],
  ['Buenos Aires', 'Buenos Aires', 'AR', 'America/Argentina/Buenos_Aires', 14967000],
  ['Istanbul', 'Istanbul', 'TR', 'Europe/Istanbul', 14751000],
  ['Kolkata', 'West Bengal', 'IN', 'Asia/Kolkata', 14681000],
  ['Manila', 'Manila', 'PH', 'Asia/Manila', 13482000],
  ['Lagos', 'Lagos', 'NG', 'Africa/Lagos', 13463000],
  ['Rio de Janeiro', 'Rio de Janeiro', 'BR', 'America/Sao_Paulo', 13293000],
  ['Los Angeles', 'California', 'US', 'America/Los_Angeles', 12458000],
  ['Moscow', 'Moscow', 'RU', 'Europe/Moscow', 12410000],
  ['Paris', 'Île-de-France', 'FR', 'Europe/Paris', 10901000],
  ['Jakarta', 'Jakarta', 'ID', 'Asia/Jakarta', 10517000],
  ['Lima', 'Lima', 'PE', 'America/Lima', 10391000],
  ['Bangkok', 'Bangkok', 'TH', 'Asia/Bangkok', 10156000],
  ['London', 'England', 'GB', 'Europe/London', 9046000],
  ['Tehran', 'Tehran', 'IR', 'Asia/Tehran', 8896000],
  ['Bogotá', 'Bogotá', 'CO', 'America/Bogota', 8896000],
  ['Hong Kong', 'Hong Kong', 'HK', 'Asia/Hong_Kong', 7429000],
  ['Lahore', 'Punjab', 'PK', 'Asia/Karachi', 7429000],
  ['Chicago', 'Illinois', 'US', 'America/Chicago', 8865000],
  ['Bengaluru', 'Karnataka', 'IN', 'Asia/Kolkata', 8443000],
  ['Ho Chi Minh City', 'Hồ Chí Minh', 'VN', 'Asia/Ho_Chi_Minh', 8145000],
  ['Singapore', 'Singapore', 'SG', 'Asia/Singapore', 5638000],
  ['Madrid', 'Madrid', 'ES', 'Europe/Madrid', 6497000],
  ['Toronto', 'Ontario', 'CA', 'America/Toronto', 6082000],
  ['Sydney', 'New South Wales', 'AU', 'Australia/Sydney', 4925000],
  ['Melbourne', 'Victoria', 'AU', 'Australia/Melbourne', 4850000],
  ['Johannesburg', 'Gauteng', 'ZA', 'Africa/Johannesburg', 4435000],
  ['Berlin', 'Berlin', 'DE', 'Europe/Berlin', 3557000],
  ['Rome', 'Lazio', 'IT', 'Europe/Rome', 2873000],
  ['Nairobi', 'Nairobi', 'KE', 'Africa/Nairobi', 4397000],
  ['Seoul', 'Seoul', 'KR', 'Asia/Seoul', 9963000],
  ['Houston', 'Texas', 'US', 'America/Chicago', 2320000],
  ['Phoenix', 'Arizona', 'US', 'America/Phoenix', 1660000],
  ['Denver', 'Colorado', 'US', 'America/Denver', 727000],
  ['Amsterdam', 'North Holland', 'NL', 'Europe/Amsterdam', 862000],
  ['Stockholm', 'Stockholm', 'SE', 'Europe/Stockholm', 975000],
  ['Dublin', 'Leinster', 'IE', 'Europe/Dublin', 1173000],
  ['Lisbon', 'Lisbon', 'PT', 'Europe/Lisbon', 506000],
  ['Auckland', 'Auckland', 'NZ', 'Pacific/Auckland', 1467000],
  ['Vancouver', 'British Columbia', 'CA', 'America/Vancouver', 675000],
  ['Santiago', 'Santiago', 'CL', 'America/Santiago', 6158000],
  ['Warsaw', 'Mazovia', 'PL', 'Europe/Warsaw', 1790000],
  ['Athens', 'Attica', 'GR', 'Europe/Athens', 664000],
  ['Vienna', 'Vienna', 'AT', 'Europe/Vienna', 1897000],
  ['Tel Aviv', 'Tel Aviv', 'IL', 'Asia/Jerusalem', 451000],
  ['Casablanca', 'Casablanca-Settat', 'MA', 'Africa/Casablanca', 3360000],
  ['Accra', 'Greater Accra', 'GH', 'Africa/Accra', 2388000],
  ['Kyiv', 'Kyiv', 'UA', 'Europe/Kyiv', 2963000],
  ['Honolulu', 'Hawaii', 'US', 'Pacific/Honolulu', 350000],
];

/** Strip diacritics and case so "sao paulo" finds "São Paulo". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export class CityIndex {
  readonly cities: readonly City[];
  readonly usingFallback: boolean;
  private readonly folded: string[];
  /** First folded character -> row positions, so a keystroke scans a slice. */
  private readonly buckets = new Map<string, number[]>();

  constructor(cities: City[], usingFallback = false) {
    this.cities = cities;
    this.usingFallback = usingFallback;
    this.folded = cities.map((c) => fold(c.name));
    this.folded.forEach((name, i) => {
      const head = name[0] ?? '';
      let bucket = this.buckets.get(head);
      if (bucket === undefined) this.buckets.set(head, (bucket = []));
      bucket.push(i);
    });
  }

  /**
   * Cities whose name starts with `query`. Input order is population
   * descending, so the first matches are the ones most people mean.
   */
  search(query: string, limit = 8): City[] {
    const needle = fold(query);
    if (needle.length === 0) return [];
    const bucket = this.buckets.get(needle[0]!);
    if (bucket === undefined) return [];

    const out: City[] = [];
    for (const i of bucket) {
      if (this.folded[i]!.startsWith(needle)) {
        out.push(this.cities[i]!);
        if (out.length === limit) break;
      }
    }
    return out;
  }
}

let pending: Promise<CityIndex> | null = null;

/** Fetch and index the city list. Cached; safe to call on every focus. */
export function loadCities(url = '/data/cities.json'): Promise<CityIndex> {
  if (pending !== null) return pending;

  pending = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status}`);
      const json = (await response.json()) as CitiesJson;
      const cities = json.cities.map(([name, admin1, country, tz, population]) => ({
        name,
        admin1,
        country: json.countries[country] ?? '',
        tzid: json.tz[tz] ?? 'UTC',
        population,
      }));
      if (cities.length === 0) throw new Error('empty city list');
      return new CityIndex(cities);
    } catch {
      // A missing city file degrades the choice on offer, not the app.
      return new CityIndex(
        FALLBACK.map(([name, admin1, country, tzid, population]) => ({
          name, admin1, country, tzid, population,
        })),
        true,
      );
    }
  })();

  return pending;
}

/** How a city reads in the input once chosen. */
export function cityLabel(city: City): string {
  // City-states and same-named regions would otherwise read "New York, New
  // York, US" or "Singapore, Singapore, SG".
  const region = city.admin1 === city.name ? '' : city.admin1;
  return [city.name, region, city.country].filter(Boolean).join(', ');
}
