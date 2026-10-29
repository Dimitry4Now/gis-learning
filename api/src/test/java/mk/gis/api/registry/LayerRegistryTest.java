package mk.gis.api.registry;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.json.JsonMapper;

class LayerRegistryTest {

    private static final SourceDefinition OSM = new SourceDefinition("osm", "OSM", "OSM contributors", "file",
            null, null, "ODbL 1.0", null, "© OpenStreetMap contributors", null, null, null);

    @Test
    void shippedRegistryIsValid() {
        LayerRegistry registry = assertDoesNotThrow(() -> new LayerRegistry(JsonMapper.builder().build()));
        assertTrue(registry.layer("osm-municipalities").isPresent());
        assertEquals("municipalities", registry.layer("osm-municipalities").get().table());
    }

    @Test
    void rejectsTableNameThatIsNotAnIdentifier() {
        var layer = layer("bad", "places; DROP TABLE places", "name");
        var e = assertThrows(IllegalStateException.class, () -> new LayerRegistry(List.of(OSM), List.of(layer)));
        assertTrue(e.getMessage().contains("invalid table name"));
    }

    @Test
    void rejectsFieldNameThatIsNotAnIdentifier() {
        var layer = layer("bad", "places", "name, (SELECT 1)");
        assertThrows(IllegalStateException.class, () -> new LayerRegistry(List.of(OSM), List.of(layer)));
    }

    @Test
    void rejectsUnknownSource() {
        var layer = layer("bad", "places", "name");
        assertThrows(IllegalStateException.class, () -> new LayerRegistry(List.of(), List.of(layer)));
    }

    @Test
    void rejectsDuplicateLayerIds() {
        var a = layer("same", "places", "name");
        var b = layer("same", "pharmacies", "name");
        assertThrows(IllegalStateException.class, () -> new LayerRegistry(List.of(OSM), List.of(a, b)));
    }

    private static LayerDefinition layer(String id, String table, String field) {
        return new LayerDefinition(id, id, "Test", "osm", table, null, "point", "EPSG:4326", "osm_id",
                List.of(new FieldDefinition(field, "Field", "string", false)), "all", null, 0, 100, true, "circle", null);
    }
}
