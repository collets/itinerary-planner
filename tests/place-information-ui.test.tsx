// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlaceInformation } from '../src/components/PlaceInformation';
import { information } from './fixtures/place-information';
vi.mock('../src/client/context', () => ({
  useTrip: () => ({
    trip: {
      state: { exchangeRates: [{ currency: 'PLN', euroPerUnit: 0.25, asOf: '2026-10-05' }] },
    },
  }),
}));
afterEach(cleanup);
describe('Researched information preview and detail', () => {
  it('renders inline field sources, the checked date, original price and approximate euro value', () => {
    const value = information();
    value.price!.currency = 'PLN';
    render(<PlaceInformation information={value} />);
    expect(screen.getByText(/05\/10\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/12\/11\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/≈.*5,00.*6,25/)).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'Museo sintetico: visite' })) {
      expect(link).toHaveAttribute('href', 'https://museum.example/');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(screen.getByText(/non un pagamento/)).toBeInTheDocument();
  });
  it('labels unknown openings and prices rather than implying free admission', () => {
    const value = information();
    value.price = null;
    value.openingHours = null;
    render(<PlaceInformation information={value} />);
    expect(screen.getByText('Aperture per questa data da verificare.')).toBeInTheDocument();
    expect(screen.getByText('Prezzo del biglietto da verificare.')).toBeInTheDocument();
  });
});
