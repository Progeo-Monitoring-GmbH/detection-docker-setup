import { Controller, Control } from 'react-hook-form';
import DatePicker from 'react-datepicker';

type FormValues = {
  date: Date | null;
};

interface Props {
  control: Control<FormValues>;
}

export const RedDatePicker: React.FC<Props> = ({ control }) => {
  return (
    <Controller
      control={control}
      name="date"
      rules={{
        required: {
          value: true,
          message: 'This field is required!',
        },
      }}
      render={({ field: { onChange, onBlur, value, ref }, fieldState }) => (
        <div>
          <DatePicker
            // react-datepicker bits
            showIcon
            dateFormat="dd.MM.yyyy"
            placeholderText="Datum"
            className={`customDatePicker ${
              fieldState.invalid ? 'is-invalid' : ''
            }`}
            // RHF wiring
            selected={value}
            onChange={(date) => {
              // `date` is Date | null
              onChange(date);
            }}
            onBlur={onBlur}
            // react-datepicker expects `ref` on input
            ref={ref}
          />

          {fieldState.error && (
            <p className="error-message">{fieldState.error.message}</p>
          )}
        </div>
      )}
    />
  );
};
