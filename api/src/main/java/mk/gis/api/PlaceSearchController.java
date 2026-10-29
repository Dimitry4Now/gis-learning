package mk.gis.api;

import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Place search and place listings over the OSM places table. The ETL stores every spelling of a name (Cyrillic, Latin
 * with and without digraphs, English, Albanian) in search_text, so one trigram index covers all of them.
 */
@RestController
@RequestMapping(path = "/api", produces = MediaType.APPLICATION_JSON_VALUE)
public class PlaceSearchController {

    private static final String EMPTY = "{\"type\":\"FeatureCollection\",\"features\":[]}";

    // Same set as PLACE_RANK in etl/load_osm.py
    private static final Set<String> PLACE_TYPES = Set.of(
            "city", "town", "village", "suburb", "quarter", "neighbourhood",
            "hamlet", "locality", "isolated_dwelling", "square");

    private final JdbcClient jdbc;

    public PlaceSearchController(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/search")
    public String search(@RequestParam String q, @RequestParam(defaultValue = "8") int limit) {
        String query = normalize(q);
        if (query.length() < 2) {
            return EMPTY;
        }

        // Prefix matches on any word come first, then bigger places, then fuzzy matches (typos)
        return jdbc.sql("""
                WITH matches AS (
                  SELECT osm_id, name, name_en, place, place_rank, geom,
                    CASE WHEN search_text LIKE :prefix OR search_text LIKE :wordPrefix THEN 0 ELSE 1 END AS match_rank,
                    word_similarity(:q, search_text) AS similarity
                  FROM places
                  WHERE search_text LIKE :contains OR :q <% search_text
                  ORDER BY match_rank, place_rank, similarity DESC, name
                  LIMIT :limit
                )
                SELECT json_build_object(
                  'type', 'FeatureCollection',
                  'features', coalesce(json_agg(json_build_object(
                    'type', 'Feature',
                    'id', osm_id,
                    'geometry', ST_AsGeoJSON(geom, 6)::json,
                    'properties', json_build_object('name', name, 'name_en', name_en, 'place', place)
                  ) ORDER BY match_rank, place_rank, similarity DESC, name), '[]'::json)
                )::text
                FROM matches
                """)
                .param("q", query)
                .param("prefix", escapeLike(query) + "%")
                .param("wordPrefix", "% " + escapeLike(query) + "%")
                .param("contains", "%" + escapeLike(query) + "%")
                .param("limit", Math.clamp(limit, 1, 20))
                .query(String.class)
                .single();
    }

    @GetMapping("/places")
    public String places(@RequestParam(name = "type") List<String> types) {
        if (types.isEmpty() || !PLACE_TYPES.containsAll(types)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "type must be one of " + PLACE_TYPES);
        }
        return jdbc.sql("""
                SELECT json_build_object(
                  'type', 'FeatureCollection',
                  'features', coalesce(json_agg(json_build_object(
                    'type', 'Feature',
                    'id', osm_id,
                    'geometry', ST_AsGeoJSON(geom, 6)::json,
                    'properties', json_build_object(
                      'name', name, 'name_en', name_en, 'place', place, 'place_rank', place_rank)
                  ) ORDER BY place_rank, name), '[]'::json)
                )::text
                FROM places
                WHERE place IN (:types)
                """)
                .param("types", types)
                .query(String.class)
                .single();
    }

    /** Lowercase and strip diacritics. Must stay in sync with normalize() in etl/load_osm.py. */
    static String normalize(String value) {
        String decomposed = Normalizer.normalize(value.toLowerCase(Locale.ROOT), Normalizer.Form.NFKD);
        return decomposed.replaceAll("\\p{M}", "").trim().replaceAll("\\s+", " ");
    }

    private static String escapeLike(String value) {
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }
}
