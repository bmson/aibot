import { personInitials } from '@assistant/application/people-presentation';

/**
 * An initials disc. There is no photograph anywhere in the data model, so this
 * is an identity marker rather than a placeholder for one — it never implies a
 * missing image, and it gives a row of people something to scan by other than
 * left-aligned text.
 */
export function PersonAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass =
    size === 'lg'
      ? 'size-14 text-base'
      : size === 'sm'
        ? 'size-8 text-[0.625rem]'
        : 'size-10 text-xs';
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-sunken font-medium tracking-[0.02em] text-muted ring-1 ring-edge/60 ${sizeClass}`}
    >
      {personInitials(name)}
    </span>
  );
}
