import UAActor from "./un-aactor"

/* UE2 Engine.Controller - pawn possession lives in UnrealScript (Phase 4), this is the
   decode-side shell other controllers are declared against. */
abstract class UController extends UAActor {}

export default UController;
export { UController };
