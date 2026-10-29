package mk.gis.api.registry;

/** A data provider and dataset the application can use: who supplies it, how, and under which terms. */
public record SourceDefinition(
        String id,
        String name,
        String provider,
        String type,
        String access,
        String url,
        String license,
        String licenseUrl,
        String attribution,
        String coverage,
        String updateFrequency,
        String knownLimitations) {
}
