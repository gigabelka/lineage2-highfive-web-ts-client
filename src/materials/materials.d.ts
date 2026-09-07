declare module "*.vs" {
    const value: string;
    export default value;
}

declare module "*.fs" {
    const value: string;
    export default value;
}

declare module "*.glsl" {
    const value: string;
    export default value;
}

type ParticleMaterialInitSettings_T = {
    name: string
    type: "sprite" | "texture",
    map: GD.IDecodedParameter,
    sprites: GD.IDecodedParameter[],
    blendingMode: GD.ParticleBlendModes_T,
    opacity: number,
    framerate?: number
};

type ParticleMaterial = import("./particle-material/particle-material").default;