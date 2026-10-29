package mk.gis.api;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Spatial endpoints. PostGIS builds the GeoJSON itself, so the API passes it through as a string
 * instead of mapping geometries to Java objects.
 */
@RestController
@RequestMapping(path = "/api", produces = MediaType.APPLICATION_JSON_VALUE)
public class GeoController {

    private final JdbcClient jdbc;

    public GeoController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/municipalities")
    public String municipalities() {
        // Simplify to ~50 m tolerance: the full boundaries are several MB, far more detail than a web map needs
        return jdbc.sql("""
                SELECT json_build_object(
                  'type', 'FeatureCollection',
                  'features', coalesce(json_agg(json_build_object(
                    'type', 'Feature',
                    'id', osm_id,
                    'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.0005), 6)::json,
                    'properties', json_build_object('name', name)
                  )), '[]'::json)
                )::text
                FROM municipalities
                """)
                .query(String.class)
                .single();
    }

    @GetMapping("/pharmacies/nearest")
    public String nearestPharmacies(
            @RequestParam double lat,
            @RequestParam double lon,
            @RequestParam(defaultValue = "5") int limit) {
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "lat/lon out of range");
        }
        int n = Math.clamp(limit, 1, 50);

        // <-> uses the spatial index but measures in degrees, which distorts east-west distances.
        // So the index picks a generous candidate set, then the candidates are re-ranked by true
        // distance on the spheroid (geography cast, in metres).
        return jdbc.sql("""
                WITH point AS (
                  SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) AS geom
                ),
                candidates AS (
                  SELECT p.osm_id, p.name, p.geom
                  FROM pharmacies p, point
                  ORDER BY p.geom <-> point.geom
                  LIMIT :candidates
                ),
                ranked AS (
                  SELECT c.*, ST_Distance(c.geom::geography, point.geom::geography) AS distance_m
                  FROM candidates c, point
                  ORDER BY distance_m
                  LIMIT :limit
                )
                SELECT json_build_object(
                  'type', 'FeatureCollection',
                  'features', coalesce(json_agg(json_build_object(
                    'type', 'Feature',
                    'id', osm_id,
                    'geometry', ST_AsGeoJSON(geom, 6)::json,
                    'properties', json_build_object('name', name, 'distance_m', round(distance_m))
                  ) ORDER BY distance_m), '[]'::json)
                )::text
                FROM ranked
                """)
                .param("lat", lat)
                .param("lon", lon)
                .param("limit", n)
                .param("candidates", n * 4)
                .query(String.class)
                .single();
    }
}
