import { TickerDetail } from '@/components/ticker/TickerDetail';

export const dynamic = 'force-dynamic';

export default function TickerPage({ params }: { params: { symbol: string } }): JSX.Element {
  return <TickerDetail symbol={params.symbol.toUpperCase()} />;
}
