import UParticleEmitter from "./un-particle-emitter";

// TrailEmitter: spawns a ribbon that trails a moving actor (TrailEmitter.uc).
// Not ported to the client renderer yet - we deserialize it just far enough to
// keep the owning Emitter's `Emitters` array readable, then emit nothing so the
// sector still decodes (see un-emitter.ts, which filters out undefined results).
abstract class UTrailEmitter extends UParticleEmitter {
    declare protected maxParticlePoints: number;
    declare protected trailScaleRepeats: number;
    declare protected useConstantLength: boolean;
    declare protected constantLength: number;
    declare protected useTrailScale: boolean;
    declare protected trailScale: any[];
    declare protected leadingTrail: boolean;
    declare protected distanceThreshold: number;
    declare protected affectedByWind: boolean;
    declare protected texEnd: number;
    declare protected texStart: number;

    public getPropertyMap(): Record<string, string> {
        return Object.assign({}, super.getPropertyMap(), {
            "MaxParticlePoints": "maxParticlePoints",
            "TrailScaleRepeats": "trailScaleRepeats",
            "UseConstantLength": "useConstantLength",
            "ConstantLength": "constantLength",
            "UseTrailScale": "useTrailScale",
            "TrailScale": "trailScale",
            "LeadingTrail": "leadingTrail",
            "DistanceThreshold": "distanceThreshold",
            "AffectedByWind": "affectedByWind",
            "TexEnd": "texEnd",
            "TexStart": "texStart",
        });
    }

    public getDecodeInfo(_builder: GD.DecodeLibraryBuilder) {
        console.warn(`TrailEmitter '${this.objectName}' is not supported yet, skipping`);
        return undefined;
    }
}

export default UTrailEmitter;
