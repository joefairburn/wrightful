import styles from "./styles.css?url";
import { Providers } from "./providers";

export const Document: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Wrightful</title>
      <link rel="stylesheet" href={styles} />
      <link rel="modulepreload" href="/src/client.tsx" />
    </head>
    <body>
      <Providers>{children}</Providers>
      <script>import("/src/client.tsx")</script>
    </body>
  </html>
);
