import UParticleEmitter from "./un-particle-emitter"

abstract class UMeshEmitter extends UParticleEmitter {
    declare protected mesh: GA.UStaticMesh;

    public getPropertyMap(): Record<string, string> {
        return Object.assign({}, super.getPropertyMap(), {
            "StaticMesh": "mesh"
        });
    }

    public getDecodeInfo(builder: GD.DecodeLibraryBuilder) {
        if (!this.mesh) {
            console.warn(`MeshEmitter '${this.objectName}' has no static mesh, skipping`);
            return null;
        }

        // super returns undefined for emitters with no live particles / non-unit
        // sizeScale (caller filters those out) - nothing to assign onto then
        const baseInfo = super.getDecodeInfo(builder);
        if (!baseInfo) return null;

        return Object.assign(baseInfo, {
            type: "MeshEmitter",
            mesh: builder.pullStaticMesh(this.mesh)
        });
    }
}

export default UMeshEmitter;
export { UParticleEmitter };
