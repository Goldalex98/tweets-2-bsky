import * as React from 'react';
import { cn } from '../../lib/utils';

const Label = React.forwardRef<HTMLLabelElement, React.ComponentProps<'label'>>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper — callers associate it via htmlFor or by nesting the control
  <label ref={ref} className={cn('text-sm font-medium leading-none text-muted-foreground', className)} {...props} />
));
Label.displayName = 'Label';

export { Label };
