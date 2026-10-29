package mk.gis.api.registry;

/**
 * One attribute of a layer. type is one of string, number, boolean, date. internal fields are sent
 * to the map for rendering (e.g. a label position) but not shown to users as attributes; it is
 * optional in the registry file and defaults to false.
 */
public record FieldDefinition(String name, String label, String type, Boolean internal) {

    public FieldDefinition {
        internal = Boolean.TRUE.equals(internal);
    }
}
