import { Button } from './ui/Button.js';

interface MigrationNoticeProps {
  onDismiss: () => void;
}

export function MigrationNotice({ onDismiss }: MigrationNoticeProps) {
  return (
    <div
      className="absolute inset-0 bg-black/70 flex items-center justify-center z-100"
      onClick={onDismiss}
    >
      <div
        className="pixel-panel py-24 px-32 max-w-xl text-center leading-[1.3]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Fork copy: this fork's revision-2 default layout is what resets the office. */}
        <div className="text-5xl mb-12 text-accent">A new floor plan!</div>
        <p className="text-xl m-0 mb-12">
          The office now has a Direction office for the boss, next to the lounge, and the employees
          work at the desks of the open space.
        </p>
        <p className="text-xl m-0 mb-12">
          Your previous layout was the old default, so it was replaced. If you had made your own,
          import it again from Layout and point the pixel-agents.bossArea setting at the Area where
          the boss should sit.
        </p>
        <Button variant="accent" size="xl" onClick={onDismiss}>
          Got it
        </Button>
      </div>
    </div>
  );
}
