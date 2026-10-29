package mk.gis.api;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import mk.gis.api.registry.FieldDefinition;
import mk.gis.api.registry.LayerDefinition;
import mk.gis.api.registry.LayerRegistry;
import mk.gis.api.registry.SourceDefinition;

/** The source and layer registries, plus one generic GeoJSON endpoint for any registered layer. */
@RestController
@RequestMapping(path = "/api", produces = MediaType.APPLICATION_JSON_VALUE)
public class LayerController {

    /** When and from what a layer's table was last loaded, as recorded by the ETL. */
    public record LayerLoad(String tableName, long rowCount, OffsetDateTime loadedAt, String sourceFile,
            OffsetDateTime sourceModified) {
    }

    /** load is null when the table has never been loaded, so the layer is unavailable. */
    public record LayerSummary(LayerDefinition layer, LayerLoad load) {
    }

    private final LayerRegistry registry;
    private final JdbcClient jdbc;

    public LayerController(LayerRegistry registry, JdbcClient jdbc) {
        this.registry = registry;
        this.jdbc = jdbc;
    }

    @GetMapping("/sources")
    public List<SourceDefinition> sources() {
        return registry.sources();
    }

    @GetMapping("/layers")
    public List<LayerSummary> layers() {
        Map<String, LayerLoad> loads = loads();
        return registry.layers().stream()
                .map(l -> new LayerSummary(l, loads.get(l.table())))
                .toList();
    }

    @GetMapping("/layers/{id}/features")
    public String features(@PathVariable String id, @RequestParam(required = false) List<Double> bbox) {
        LayerDefinition layer = registry.layer(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "unknown layer " + id));
        if (bbox != null && !isValidBbox(bbox)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "bbox must be west,south,east,north in degrees");
        }

        JdbcClient.StatementSpec query = jdbc.sql(featuresSql(layer, bbox != null))
                .param("max", layer.maxFeatures());
        if (bbox != null) {
            query = query.param("west", bbox.get(0)).param("south", bbox.get(1))
                    .param("east", bbox.get(2)).param("north", bbox.get(3));
        }
        try {
            return query.query(String.class).single();
        } catch (BadSqlGrammarException e) {
            // Most likely the ETL has not created the table yet
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "layer " + id + " is not loaded", e);
        }
    }

    /**
     * Builds the GeoJSON query from the registry. Identifiers are validated by LayerRegistry, and all
     * request values are bound as parameters. One row more than maxFeatures is read to detect truncation.
     */
    static String featuresSql(LayerDefinition layer, boolean withBbox) {
        String properties = layer.fields().stream()
                .map(FieldDefinition::name)
                .map(name -> "'" + name + "', " + name)
                .collect(Collectors.joining(", "));
        String geometry = layer.simplify() == null
                ? "geom"
                : "ST_SimplifyPreserveTopology(geom, " + layer.simplify() + ")";
        String where = layer.where() == null ? "" : " AND (" + layer.where() + ")";
        String bbox = withBbox ? " AND ST_Intersects(geom, ST_MakeEnvelope(:west, :south, :east, :north, 4326))" : "";

        return """
                WITH rows AS (
                  SELECT %s AS id, %s AS geom, json_build_object(%s) AS properties,
                    row_number() OVER () AS n
                  FROM %s
                  WHERE geom IS NOT NULL%s%s
                  LIMIT :max + 1
                )
                SELECT json_build_object(
                  'type', 'FeatureCollection',
                  'truncated', count(*) > :max,
                  'features', coalesce(json_agg(json_build_object(
                    'type', 'Feature',
                    'id', id,
                    'geometry', ST_AsGeoJSON(geom, 6)::json,
                    'properties', properties
                  )) FILTER (WHERE n <= :max), '[]'::json)
                )::text
                FROM rows
                """.formatted(layer.idField(), geometry, properties, layer.table(), where, bbox);
    }

    private Map<String, LayerLoad> loads() {
        try {
            return jdbc.sql("SELECT table_name, row_count, loaded_at, source_file, source_modified FROM layer_loads")
                    .query(LayerLoad.class)
                    .list()
                    .stream()
                    .collect(Collectors.toMap(LayerLoad::tableName, Function.identity()));
        } catch (BadSqlGrammarException e) {
            return Map.of(); // ETL older than the load log; every layer shows as unavailable until it reruns
        }
    }

    private static boolean isValidBbox(List<Double> b) {
        return b.size() == 4
                && b.get(0) >= -180 && b.get(2) <= 180 && b.get(0) < b.get(2)
                && b.get(1) >= -90 && b.get(3) <= 90 && b.get(1) < b.get(3);
    }
}
