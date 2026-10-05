import { useEffect, useRef, useId, type ReactNode } from 'react';
import { X } from 'lucide-react';

let scrollLocks = 0;
let restoreScroll: (() => void) | undefined;

function lockPageScroll() {
  if (scrollLocks++ === 0) {
    const { scrollX, scrollY } = window;
    const root = document.documentElement;
    const body = document.body;
    const scrollbar = window.innerWidth - root.clientWidth;
    const padding = parseFloat(getComputedStyle(body).paddingRight);
    const updates: [HTMLElement, Record<string, string>][] = [
      [root, { overflow: 'hidden', 'overscroll-behavior': 'none' }],
      [
        body,
        {
          position: 'fixed',
          top: `${-scrollY}px`,
          left: `${-scrollX}px`,
          right: '0',
          overflow: 'hidden',
          'padding-right': `${padding + scrollbar}px`,
        },
      ],
    ];
    const previous = updates.flatMap(([element, properties]) =>
      Object.entries(properties).map(([property, value]) => {
        const oldValue = element.style.getPropertyValue(property);
        const priority = element.style.getPropertyPriority(property);
        element.style.setProperty(property, value);
        return () => {
          if (oldValue) element.style.setProperty(property, oldValue, priority);
          else element.style.removeProperty(property);
        };
      }),
    );
    restoreScroll = () => {
      previous.forEach((restore) => restore());
      window.scrollTo(scrollX, scrollY);
    };
  }
  return () => {
    if (--scrollLocks === 0) {
      restoreScroll?.();
      restoreScroll = undefined;
    }
  };
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleRef = useRef<HTMLHeadingElement>(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const unlockPage = lockPageScroll();
    if (!dialog.open) dialog.showModal();
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      unlockPage();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <h2 id={id} ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Chiudi">
          <X size={20} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
