/**
 * How many pictures and clips one agent turn may make, and what the model is
 * told when a call over that limit is dropped.
 *
 * Discord 05.11.2026 (D6): the user declined a video_generate call, then asked
 * to try again. The new message carried no video word ("try again", in Polish
 * too), so the turn's video limit was 0 and the call was dropped before it
 * ran. The model was then told "the media you were asked for is already
 * created and shown", and passed that on: the chat said "video generated",
 * and there was no video.
 *
 * Two rules now:
 *  - A clip is held back only when this message plainly asks for a picture
 *    and not a clip, or when video is switched off. A message that names no
 *    medium ("again", "try again") leaves one clip open; the call still needs
 *    the user's approval where the permissions ask for it.
 *  - The note after a dropped call says "already created" only when this turn
 *    did create something. Otherwise it says that nothing was made, and why.
 */

export interface MediaWants {
  /** This message (or the router's hint) asks for a picture. */
  wantsImage: boolean
  /** This message (or the router's hint) asks for a clip. */
  wantsVideo: boolean
  /** Video generation is not switched off in the tool permissions. */
  videoAllowed: boolean
}

/** The most pictures and clips this turn may make. */
export function mediaTurnCaps({ wantsImage, wantsVideo, videoAllowed }: MediaWants): { maxImage: number; maxVideo: number } {
  return {
    // A clip was asked for and no picture: a picture call is a detour.
    maxImage: wantsVideo && !wantsImage ? 0 : 1,
    // A picture was asked for and no clip, or video is off: no clip.
    maxVideo: videoAllowed && (wantsVideo || !wantsImage) ? 1 : 0,
  }
}

export interface DroppedMedia {
  /** Pictures and clips this turn did deliver. */
  imagesDone: number
  videosDone: number
  /** A video_generate call was among the dropped ones. */
  droppedVideo: boolean
  videoAllowed: boolean
}

/** What the model reads after every media call it made was dropped. */
export function droppedMediaNote({ imagesDone, videosDone, droppedVideo, videoAllowed }: DroppedMedia): string {
  if (imagesDone + videosDone > 0) {
    return 'Stop, the media you were asked for is already created and shown. Write ONLY a short, friendly closing line to the user in their own language (e.g. that their picture/clip is ready). Do not output JSON, do not repeat this note, and do not call any tool.'
  }
  const why = droppedVideo && !videoAllowed
    ? 'Video generation is switched off in the tool permissions, so no clip was made.'
    : 'That call did not run, so nothing was generated in this turn.'
  return `Stop: ${why} Do not say that a picture or a clip was created. Tell the user in one short sentence, in their own language, that nothing was generated, and ask what they want made. Do not output JSON and do not call any tool.`
}
