import LaunchForm from "@/components/LaunchForm";
import { Container } from "@/components/ui/container";
import { MarketsProvider } from "@/components/markets-provider";

export const metadata = { title: "Launch" };

export default function LaunchPage() {
  return (
    <MarketsProvider>
      <Container>
        <LaunchForm />
      </Container>
    </MarketsProvider>
  );
}
