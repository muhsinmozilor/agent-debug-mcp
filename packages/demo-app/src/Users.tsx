import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';

interface User {
  id: number;
  name: string;
}

async function fetchUsers(page: number): Promise<User[]> {
  await new Promise((r) => setTimeout(r, 50));
  return Array.from({ length: 5 }, (_, i) => ({ id: page * 100 + i, name: `user-${page}-${i}` }));
}

export function Users() {
  const { page } = useSearch({ from: '/users' });
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users', { page }], queryFn: () => fetchUsers(page) });
  const rename = useMutation({
    mutationFn: async (id: number) => ({ id, name: 'renamed' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
  return (
    <section data-testid="users">
      <h2>Users (page {page})</h2>
      {users.isPending && <p>loading…</p>}
      <ul>
        {users.data?.map((u) => (
          <li key={u.id} data-testid={`user-${u.id}`}>
            {u.name} <button onClick={() => rename.mutate(u.id)}>rename</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
