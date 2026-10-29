package mk.gis.api;

import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Spatial endpoints that are not plain layers. PostGIS builds the GeoJSON itself, so the API passes
 * it through as a string instead of mapping geometries to Java objects.
 */
@RestController
@RequestMapping(path = "/api", produces = MediaType.APPLICATION_JSON_VALUE)
public class GeoController {

    private final JdbcClient jdbc;

    public GeoController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/country")
    public String country() {
        return jdbc.sql("SELECT ST_AsGeoJSON(geom, 5) FROM country")
                .query(String.class)
                .single();
    }
}
