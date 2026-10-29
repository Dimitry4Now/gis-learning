package mk.gis.api.registry;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Data sources and layers, read from registry/*.json on the classpath and validated at startup.
 *
 * The registry is trusted server-side configuration: table, field and where values are put into SQL,
 * so identifiers are checked here and the files must never be filled from user input.
 */
@Component
public class LayerRegistry {

    private static final Pattern IDENTIFIER = Pattern.compile("[a-z_][a-z0-9_]*");
    private static final Set<String> GEOMETRY_TYPES = Set.of("point", "line", "polygon");
    private static final Set<String> FIELD_TYPES = Set.of("string", "number", "boolean", "date");
    private static final Set<String> LOADING = Set.of("all", "viewport");
    private static final Set<String> RENDERERS = Set.of("fill-outline", "circle", "place-labels");

    private final List<SourceDefinition> sources;
    private final List<LayerDefinition> layers;

    @Autowired
    public LayerRegistry(JsonMapper json) throws IOException {
        this(read(json, "registry/sources.json", new TypeReference<>() {}),
                read(json, "registry/layers.json", new TypeReference<>() {}));
    }

    // For tests: registry contents without reading the classpath files
    LayerRegistry(List<SourceDefinition> sources, List<LayerDefinition> layers) {
        validate(sources, layers);
        this.sources = List.copyOf(sources);
        this.layers = List.copyOf(layers);
    }

    public List<SourceDefinition> sources() {
        return sources;
    }

    public List<LayerDefinition> layers() {
        return layers;
    }

    public Optional<LayerDefinition> layer(String id) {
        return layers.stream().filter(l -> l.id().equals(id)).findFirst();
    }

    private static <T> T read(JsonMapper json, String path, TypeReference<T> type) throws IOException {
        try (InputStream in = new ClassPathResource(path).getInputStream()) {
            return json.readValue(in, type);
        }
    }

    static void validate(List<SourceDefinition> sources, List<LayerDefinition> layers) {
        Set<String> sourceIds = new HashSet<>();
        for (SourceDefinition s : sources) {
            require(s.id() != null && sourceIds.add(s.id()), "duplicate or missing source id: " + s.id());
            require(s.license() != null && s.attribution() != null, "source " + s.id() + " needs license and attribution");
        }

        Set<String> layerIds = new HashSet<>();
        for (LayerDefinition l : layers) {
            String where = "layer " + l.id() + ": ";
            require(l.id() != null && layerIds.add(l.id()), "duplicate or missing layer id: " + l.id());
            require(sourceIds.contains(l.source()), where + "unknown source " + l.source());
            require(isIdentifier(l.table()), where + "invalid table name " + l.table());
            require(isIdentifier(l.idField()), where + "invalid id field " + l.idField());
            require(GEOMETRY_TYPES.contains(l.geometryType()), where + "geometryType must be one of " + GEOMETRY_TYPES);
            require(LOADING.contains(l.loading()), where + "loading must be one of " + LOADING);
            require(RENDERERS.contains(l.renderer()), where + "renderer must be one of " + RENDERERS);
            require(l.maxFeatures() > 0, where + "maxFeatures must be positive");
            require(l.fields() != null && !l.fields().isEmpty(), where + "needs at least one field");
            for (FieldDefinition f : l.fields()) {
                require(isIdentifier(f.name()), where + "invalid field name " + f.name());
                require(FIELD_TYPES.contains(f.type()), where + "field " + f.name() + " type must be one of " + FIELD_TYPES);
            }
        }
    }

    private static boolean isIdentifier(String value) {
        return value != null && IDENTIFIER.matcher(value).matches();
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException("Invalid layer registry: " + message);
        }
    }
}
