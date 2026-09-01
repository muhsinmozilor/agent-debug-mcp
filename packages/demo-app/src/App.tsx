import { createContext, memo, Suspense, useContext, useMemo, useReducer, useRef, useState } from 'react';

const ThemeContext = createContext<'light' | 'dark'>('light');
ThemeContext.displayName = 'ThemeContext';

export function App() {
  const [count, setCount] = useState(0);
  const [theme, toggleTheme] = useReducer((t: 'light' | 'dark') => (t === 'light' ? 'dark' : 'light'), 'light');
  const renders = useRef(0);
  renders.current++;
  const big = useMemo(() => ({ items: Array.from({ length: 30 }, (_, i) => ({ id: i, label: `item-${i}` })), map: new Map([['k', 1]]), when: new Date(0) }), []);
  return (
    <ThemeContext.Provider value={theme}>
      <main data-testid="app" data-theme={theme}>
        <h1>Agent Debug MCP demo</h1>
        <Counter count={count} onIncrement={() => setCount((c) => c + 1)} />
        <button data-testid="toggle-theme" onClick={toggleTheme}>theme: {theme}</button>
        <Themed />
        <MemoList items={big.items} />
        <Suspense fallback={<p>loading…</p>}>
          <Lazyish />
        </Suspense>
      </main>
    </ThemeContext.Provider>
  );
}

function Counter({ count, onIncrement }: { count: number; onIncrement: () => void }) {
  return (
    <button data-testid="increment" onClick={onIncrement}>
      count is {count}
    </button>
  );
}

function Themed() {
  const theme = useContext(ThemeContext);
  return <p data-testid="themed">theme via context: {theme}</p>;
}

const MemoList = memo(function MemoList({ items }: { items: { id: number; label: string }[] }) {
  return (
    <ul data-testid="memo-list">
      {items.slice(0, 5).map((it) => (
        <ListItem key={it.id} item={it} />
      ))}
    </ul>
  );
});

function ListItem({ item }: { item: { id: number; label: string } }) {
  return <li>{item.label}</li>;
}

function Lazyish() {
  return <p>ready</p>;
}
