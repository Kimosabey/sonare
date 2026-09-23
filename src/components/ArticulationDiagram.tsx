/**
 * A picture of where the tongue goes, when there is one.
 *
 * The seam for the articulation diagrams, built ahead of them rather than
 * with them. Sixteen are generated and sitting in `diagram-cache/`, out of the
 * build on purpose: they are unreviewed, and unreviewed content in `public/`
 * is shipped content. This component renders one **if it is there** and
 * nothing at all if it is not, so approving them is a matter of re-encoding
 * and moving files rather than of writing code under time pressure.
 *
 * ## Why "nothing at all" and never a placeholder
 *
 * The same rule the sound note follows. A missing diagram is a gap in our
 * description of a sound, not a fact about the sound — and a grey box where a
 * mouth should be reads as the app being broken, which is the one impression
 * a learner mid-take cannot afford.
 *
 * ## Why it carries no alt text describing the sound
 *
 * The diagram illustrates advice that is already on the screen in words, and
 * it is the words that a screen-reader user is served by. An `alt` attempting
 * to describe a tongue position would be a worse version of the sentence
 * beside it, read twice. So the image is decorative — `alt=""` — and the
 * instruction stays in text where it is translatable, selectable and
 * actually readable.
 *
 * That is only honest while the advice really is beside it. The component
 * takes the advice it illustrates as a prop and refuses to render without
 * one, so a diagram cannot end up standing alone as the only instruction.
 */

export interface ArticulationDiagramProps {
  /**
   * The file name the generator produced — a hash of the sound's IPA. See
   * `scripts/generate-diagrams.ts`. Null when this sound has none.
   */
  file: string | null;
  /**
   * The advice this picture illustrates, which must already be rendered
   * nearby. Passed so the component can refuse to be the only instruction.
   */
  advice: string;
}

export function ArticulationDiagram({ file, advice }: ArticulationDiagramProps) {
  if (file === null || file === "") return null;
  // A diagram with no words beside it is an instruction nobody can read aloud.
  if (advice.trim() === "") return null;

  return (
    <figure className="articulation">
      <img
        src={`/diagrams/${file}`}
        alt=""
        width={320}
        height={320}
        loading="lazy"
        decoding="async"
      />
    </figure>
  );
}
