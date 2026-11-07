import { useEffect, useState } from 'react';
import { t } from './i18n';

export function App() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.api.invoke('app:getVersion').then(setVersion);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, "Yu Gothic UI", Meiryo, sans-serif', padding: 24 }}>
      <h1 data-testid="title">{t('app.title')}</h1>
      <p data-testid="version">{t('app.version', { version })}</p>
    </main>
  );
}
