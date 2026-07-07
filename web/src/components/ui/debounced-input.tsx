import * as React from 'react';
import { Input } from './input';

interface DebouncedInputProps extends Omit<React.ComponentProps<typeof Input>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  debounce?: number;
}

export function DebouncedInput({
  value: initialValue,
  onChange,
  debounce = 180,
  ...props
}: DebouncedInputProps) {
  const [value, setValue] = React.useState(initialValue);

  // Sync internal value with external changes (e.g., when query is cleared externally)
  React.useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  React.useEffect(() => {
    const timeout = setTimeout(() => {
      onChange(value);
    }, debounce);

    return () => {
      clearTimeout(timeout);
    };
  }, [value, onChange, debounce]);

  return (
    <Input
      {...props}
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}
