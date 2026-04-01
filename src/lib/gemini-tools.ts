import { FunctionDeclaration, Type } from "@google/genai";

/**
 * Detta är verktygsdefinitionen (Tool Call) som vi skickar till Gemini Live API.
 * Den förklarar för Gemini exakt VAD verktyget gör och VILKA parametrar som krävs.
 */
export const saveSnapshotTool: FunctionDeclaration = {
  name: "save_snapshot",
  description: "Använd detta verktyg när du ser en intressant, estetiskt tilltalande eller viktig scen i videoströmmen. Verktyget sparar en högupplöst bild av händelsen.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      description: {
        type: Type.STRING,
        description: "En kort beskrivning av vad som händer på bilden och varför du valde att spara den. Exempel: 'Huvudpersonen blåser ut ljusen på tårtan'.",
      },
      timestamp_offset: {
        type: Type.NUMBER,
        description: "Uppskattad fördröjning i sekunder från det att händelsen skedde tills du anropar detta verktyg. Eftersom du analyserar video med viss fördröjning, ange hur många sekunder bakåt i tiden bilden ska hämtas (vanligtvis mellan 1 och 3).",
      },
      running_summary: {
        type: Type.STRING,
        description: "En övergripande sammanfattning av handlingen i filmen/media fram till denna punkt, baserat på ljud och bild. Uppdatera denna för att bevara den röda tråden.",
      },
      characters_detected: {
        type: Type.ARRAY,
        items: {
          type: Type.STRING,
        },
        description: "En lista med namn på personer som nämnts i ljudspåret eller kan identifieras i bilden.",
      },
    },
    required: ["description", "timestamp_offset", "running_summary", "characters_detected"],
  },
};
