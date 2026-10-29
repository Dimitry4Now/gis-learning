package mk.gis.api.registry;

import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A geographic dataset the map can show. table and where say how to read it from PostGIS; they are
 * read from the registry file but never sent to clients.
 *
 * @param loading "all" fetches the whole layer once; "viewport" fetches the visible area on every move
 * @param renderer how the web map draws it: fill-outline, line, circle or place-labels
 * @param style renderer options: color, plus width (line) and fillOpacity (fill-outline)
 */
public record LayerDefinition(
        String id,
        String name,
        String category,
        String source,
        @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) String table,
        @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) String where,
        String geometryType,
        String crs,
        String idField,
        List<FieldDefinition> fields,
        String loading,
        Double simplify,
        int minZoom,
        int maxFeatures,
        boolean defaultVisible,
        String renderer,
        Map<String, Object> style) {
}
