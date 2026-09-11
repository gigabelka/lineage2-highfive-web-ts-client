import UObject from "@l2js/core";

/* UE2 Engine.Player - base of the viewport/player chain, carried for the same reason the
   original client has it: nothing in the C4 asset tree instantiates it directly. */
abstract class UPlayer extends UObject {}

export default UPlayer;
export { UPlayer };
