package mk.gis.api.registry;

/** One attribute of a layer. type is one of string, number, boolean, date. */
public record FieldDefinition(String name, String label, String type) {
}
