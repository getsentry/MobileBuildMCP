# Atmos Weather

Atmos Weather is a native SwiftUI weather app prototype for iOS.

## Launch

Build and run the app with MobileBuildMCP:

```bash
../../build/cli.js simulator build-and-run
```

## JSON fixtures

Fixture JSON files live in:

```text
WeatherTests/Fixtures/
```

Current fixtures:

- `WeatherTests/Fixtures/default-locations.json`
- `WeatherTests/Fixtures/search-locations.json`
- `WeatherTests/Fixtures/weather-report-loc-current-san-francisco.json`

## API schemas

OpenAI-compatible API schema files live in:

```text
Schemas/
```

Current schemas:

- `Schemas/default-locations.schema.json`
- `Schemas/search-locations.schema.json`
- `Schemas/weather-report.schema.json`

These schemas describe the JSON response shape expected by the DTO layer.

## Expected API endpoints

The production client is `URLSessionWeatherAPIClient`. It currently expects a JSON API rooted at:

```text
https://api.atmosweather.example/v1
```

All endpoints are `GET` requests.

| Purpose | Method | Path | Request shape | Schema |
| --- | --- | --- | --- | --- |
| Default saved locations | `GET` | `/locations/default` | No path params, query params, or body. | `Schemas/default-locations.schema.json` |
| Search locations | `GET` | `/locations/search` | Query string: `query=<string>` | `Schemas/search-locations.schema.json` |
| Weather report for a location | `GET` | `/weather/{locationID}` | Path param: `locationID=<WeatherLocationDTO.id>` | `Schemas/weather-report.schema.json` |

### Request examples

Default locations:

```http
GET /v1/locations/default
```

Search locations:

```http
GET /v1/locations/search?query=San%20Francisco
```

Weather report:

```http
GET /v1/weather/loc-current-san-francisco
```

### Response expectations

- Responses must be JSON.
- Successful responses should use a `2xx` HTTP status code.
- Non-`2xx` responses are treated as API failures.

## Tests

Run the app test suite through MobileBuildMCP:

```bash
../../build/cli.js simulator test
```

The app uses bundled deterministic weather data so UI tests do not depend on the production API endpoint.